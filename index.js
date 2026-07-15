// Karachi Noor Biryani & Murgh Pulao - WhatsApp Order Bot
// Yeh code Meta WhatsApp Cloud API + Firebase Firestore use karta hai
// Features: Menu/Order, Payment, Automatic Rider Assignment, Delivery Tracking, Location Forwarding

const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");

const app = express();
app.use(express.json());

// ============================================
// SETTINGS - Render.com pe "Environment Variables" mein daalni hain
// ============================================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ummatfoods123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// Firebase service account JSON, Render env variable mein poora JSON string ke tor pe daalna hai
const FIREBASE_SERVICE_ACCOUNT_KEY = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

// Restaurant staff/kitchen ka WhatsApp number - dine-in (table) orders yahan notify honge
const STAFF_NUMBER = process.env.STAFF_NUMBER;

// ============================================
// FIREBASE SETUP
// ============================================
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT_KEY)),
});
const db = admin.firestore();
const ridersRef = db.collection("riders");
const ordersRef = db.collection("orders");

// ============================================
// MENU
// ============================================
const MENU = [
  { id: 1, name: "Chicken Biryani", price: 350 },
  { id: 2, name: "Mutton Pulao", price: 500 },
  { id: 3, name: "Chicken Karahi (Full)", price: 1200 },
  { id: 4, name: "Chicken Karahi (Half)", price: 650 },
  { id: 5, name: "Seekh Kabab (4 pcs)", price: 300 },
  { id: 6, name: "Raita", price: 60 },
  { id: 7, name: "Salad", price: 50 },
  { id: 8, name: "Cold Drink (500ml)", price: 80 },
];

const PAYMENT_INFO = {
  jazzcash: "0300-5583968",
  easypaisa: "0300-5583968",
  accountTitle: "Ummat Foods",
};

// Customer sessions (in-memory)
const sessions = {};

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = { stage: "menu", cart: [], address: "", customerName: "" };
  }
  return sessions[phone];
}

function menuText() {
  let text = "🍛 *Karachi Noor Biryani & Murgh Pulao*\n\nAssalam-o-Alaikum! Khush aamdeed. Neeche menu hai:\n\n";
  MENU.forEach((item) => {
    text += `${item.id}. ${item.name} - Rs. ${item.price}\n`;
  });
  text += "\nOrder karne ke liye item ka number aur quantity likhein.\nMisaal: *1x2* (matlab Chicken Biryani, 2 plates)\n\nJab order mukammal ho jaye to *done* likh dein.";
  return text;
}

function cartText(cart) {
  if (cart.length === 0) return "Aapka cart abhi khali hai.";
  let text = "🛒 *Aapka Order:*\n\n";
  let total = 0;
  cart.forEach((c) => {
    const sub = c.price * c.qty;
    total += sub;
    text += `${c.name} x${c.qty} = Rs. ${sub}\n`;
  });
  text += `\n*Total: Rs. ${total}*`;
  return text;
}

function cartTotal(cart) {
  return cart.reduce((sum, c) => sum + c.price * c.qty, 0);
}

function mapsLink(lat, lng) {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

// ============================================
// RIDER HELPERS
// ============================================

// Available rider dhoondo (Firestore query)
async function findAvailableRider() {
  const snap = await ridersRef.where("status", "==", "available").limit(1).get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return { id: doc.id, ...doc.data() };
}

// Order confirm hone par automatic rider assign karo (transaction-safe — race condition se bacha hua)
async function assignRiderToOrder(customerPhone, session) {
  const total = cartTotal(session.cart);

  // Pehle order record bana lo (rider abhi tak pata nahi)
  const orderRef = await ordersRef.add({
    customerPhone,
    cart: session.cart,
    total,
    address: session.address,
    status: "pending_rider",
    riderPhone: null,
    riderName: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Ab transaction ke andar rider dhoondo aur turant "busy" mark karo —
  // isse agar 2 orders ek sath aayen, dono ko alag-alag rider milega, ek hi rider double-assign nahi hoga
  let assignedRider = null;
  try {
    assignedRider = await db.runTransaction(async (t) => {
      const snap = await t.get(ridersRef.where("status", "==", "available").limit(1));
      if (snap.empty) return null;
      const riderDoc = snap.docs[0];
      t.update(riderDoc.ref, { status: "busy", activeOrderId: orderRef.id });
      return { id: riderDoc.id, ...riderDoc.data() };
    });
  } catch (err) {
    console.error("Rider assignment transaction failed:", err.message);
  }

  if (assignedRider) {
    await orderRef.update({
      status: "assigned",
      riderPhone: assignedRider.id,
      riderName: assignedRider.name,
    });

    const riderMsg =
      `🛵 *Naya Order Assign Hua*\n\n` +
      `${cartText(session.cart)}\n\n` +
      `Address: ${session.address}\n` +
      `Customer Number: ${customerPhone}\n\n` +
      `Jab order pick kar lein to reply karein: *1*\n` +
      `Jab deliver ho jaye to reply karein: *2*`;
    await sendMessage(assignedRider.id, riderMsg);

    return `✅ Payment screenshot mil gayi hai. Aapka order confirm ho gaya hai — *${assignedRider.name}* aapki delivery ke liye assign ho gaye hain. Jald hi pahunch jayega! 🍛`;
  } else {
    return `✅ Payment screenshot mil gayi hai. Order confirm ho gaya hai — filhal hamare riders busy hain, jaise hi koi free hota hai order assign kar diya jayega. Shukriya! 🙏`;
  }
}

// Rider ke reply "1"/"2" ko handle karo
async function handleRiderReply(riderId, text) {
  const riderDoc = await ridersRef.doc(riderId).get();
  if (!riderDoc.exists) return null; // yeh number rider nahi hai

  const rider = riderDoc.data();
  const orderId = rider.activeOrderId;
  if (!orderId) {
    return "Filhal aapke pass koi active order nahi hai.";
  }

  const orderSnap = await ordersRef.doc(orderId).get();
  if (!orderSnap.exists) return "Order record nahi mila.";
  const order = orderSnap.data();

  if (text === "1") {
    await ordersRef.doc(orderId).update({ status: "out_for_delivery" });
    await sendMessage(order.customerPhone, "🛵 Aapka order out for delivery hai! Jald hi pahunch jayega.");
    return "✅ Status update ho gaya: Out for Delivery.";
  }

  if (text === "2") {
    await ordersRef.doc(orderId).update({ status: "delivered" });
    await ridersRef.doc(riderId).update({ status: "available", activeOrderId: admin.firestore.FieldValue.delete() });
    await sendMessage(order.customerPhone, "✅ Aapka order deliver ho gaya hai. Khaane ka mazaa lein! 🍛 Shukriya Ummat Foods choose karne ke liye.");
    return "✅ Status update ho gaya: Delivered. Aap ab agla order lene ke liye available hain.";
  }

  return "Reply *1* (picked up) ya *2* (delivered) likhein.";
}

// Dine-in (table QR) order ko kitchen/staff ko notify karo (payment confirm hone ke baad)
async function notifyStaffDineIn(tableNumber, customerName, cart) {
  const msg =
    `🍽️ *Naya Dine-In Order — Table ${tableNumber}*\n` +
    `👤 Customer: ${customerName}\n` +
    `💰 Payment: Mil gayi ✅\n\n` +
    `${cartText(cart)}\n\n` +
    `Kitchen ko bata dein taake taiyari shuru ho.`;
  if (STAFF_NUMBER) {
    await sendMessage(STAFF_NUMBER, msg);
  }
}

// Customer location assigned rider ko forward karo
async function forwardLocationToRider(customerPhone, lat, lng) {
  const snap = await ordersRef
    .where("customerPhone", "==", customerPhone)
    .where("status", "in", ["assigned", "out_for_delivery"])
    .limit(1)
    .get();

  if (snap.empty) return false;
  const order = snap.docs[0].data();
  if (!order.riderPhone) return false;

  const link = mapsLink(lat, lng);
  await sendMessage(order.riderPhone, `📍 Customer ne apni location share ki hai:\n${link}`);
  return true;
}

// ============================================
// WEBHOOK VERIFICATION
// ============================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified successfully");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ============================================
// MESSAGE HANDLING
// ============================================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry && req.body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const message = value && value.messages && value.messages[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from;
    const text = (message.text && message.text.body || "").trim();
    const lower = text.toLowerCase();

    // Pehle check karo: kya yeh number ek RIDER hai?
    const riderDoc = await ridersRef.doc(from).get();
    if (riderDoc.exists) {
      const reply = await handleRiderReply(from, text.trim());
      if (reply) await sendMessage(from, reply);
      return res.sendStatus(200);
    }

    // Location message (customer ne pin bheja)
    if (message.type === "location") {
      const { latitude, longitude } = message.location;
      const forwarded = await forwardLocationToRider(from, latitude, longitude);
      const reply = forwarded
        ? "📍 Aapki location rider ko bhej di gayi hai. Shukriya!"
        : "📍 Location mil gayi, lekin filhal koi active order nahi mila.";
      await sendMessage(from, reply);
      return res.sendStatus(200);
    }

    // Normal customer flow
    const session = getSession(from);
    let reply = "";

    // QR code se aaya table order? Message format: "Order - Table 5"
    const tableMatch = text.match(/^order\s*-\s*table\s*(\d+)/i);
    if (tableMatch && session.stage === "menu") {
      session.isDineIn = true;
      session.tableNumber = tableMatch[1];
      session.stage = "ordering";
      reply = `🍽️ *Table ${session.tableNumber}* — Khush aamdeed!\n\n${menuText()}`;
    } else if (session.stage === "menu" || lower === "menu" || lower === "hi" || lower === "hello" || lower === "salam") {
      reply = menuText();
      session.stage = "ordering";
    } else if (session.stage === "ordering" && /^\d+x\d+$/.test(lower)) {
      const [itemId, qty] = lower.split("x").map(Number);
      const item = MENU.find((m) => m.id === itemId);
      if (item) {
        const existing = session.cart.find((c) => c.id === itemId);
        if (existing) {
          existing.qty += qty;
        } else {
          session.cart.push({ id: item.id, name: item.name, price: item.price, qty });
        }
        reply = `✅ ${item.name} x${qty} cart mein add ho gaya.\n\n${cartText(session.cart)}\n\nAur item add karen, ya *done* likh kar order confirm karen.`;
      } else {
        reply = "Yeh item number valid nahi hai. Menu dobara dekhne ke liye *menu* likhein.";
      }
    } else if (session.stage === "ordering" && lower === "done") {
      if (session.cart.length === 0) {
        reply = "Aapne abhi tak kuch order nahi kiya. Pehle item number likhein, jaise *1x2*.";
      } else if (session.isDineIn) {
        // Dine-in: address ki zaroorat nahi, lekin naam aur payment confirm honi chahiye
        session.stage = "dinein_name";
        reply = `${cartText(session.cart)}\n\nOrder confirm karne ke liye apna *naam* likh dein.`;
      } else {
        session.stage = "address";
        reply = `${cartText(session.cart)}\n\nAb apna delivery address likh dein.`;
      }
    } else if (session.stage === "dinein_name") {
      session.customerName = text;
      session.stage = "dinein_payment";
      const total = cartTotal(session.cart);
      reply =
        `Shukriya ${session.customerName}! 🙏\n\n` +
        `💳 *Payment Details:*\n` +
        `JazzCash: ${PAYMENT_INFO.jazzcash}\n` +
        `Easypaisa: ${PAYMENT_INFO.easypaisa}\n` +
        `Account Title: ${PAYMENT_INFO.accountTitle}\n\n` +
        `Total Amount: *Rs. ${total}*\n\n` +
        `Payment karne ke baad screenshot yahan bhej dein — order seedha kitchen ko Table ${session.tableNumber} ke naam bhej diya jayega.`;
    } else if (session.stage === "dinein_payment") {
      if (message.type === "image") {
        await notifyStaffDineIn(session.tableNumber, session.customerName, session.cart);
        reply = `✅ Payment mil gayi hai, ${session.customerName}! Aapka order kitchen ko bhej diya gaya hai — *Table ${session.tableNumber}*. Taiyar hote hi table pe pahunch jayega. Shukriya! 🍛`;
        delete sessions[from];
      } else {
        reply = "Hum aapki payment screenshot ka intezaar kar rahe hain. Bhej dein taake order kitchen tak jaye.";
      }
    } else if (session.stage === "address") {
      session.address = text;
      session.stage = "payment";
      const total = cartTotal(session.cart);
      reply =
        `📍 Address save ho gaya: ${session.address}\n\n` +
        `💳 *Payment Details:*\n` +
        `JazzCash: ${PAYMENT_INFO.jazzcash}\n` +
        `Easypaisa: ${PAYMENT_INFO.easypaisa}\n` +
        `Account Title: ${PAYMENT_INFO.accountTitle}\n\n` +
        `Total Amount: *Rs. ${total}*\n\n` +
        `Payment karne ke baad screenshot yahan bhej dein. Order confirm hote hi rider assign ho jayega. Shukriya! 🙏`;
      session.stage = "waiting_payment";
    } else if (session.stage === "waiting_payment") {
      if (message.type === "image") {
        reply = await assignRiderToOrder(from, session);
        delete sessions[from];
      } else {
        reply = "Hum aapki payment screenshot ka intezaar kar rahe hain. Bhej dein taake order confirm ho jaye.";
      }
    } else {
      reply = "Maaf kijiye, samajh nahi aaya. Menu dekhne ke liye *menu* likhein.";
    }

    await sendMessage(from, reply);
    res.sendStatus(200);
  } catch (err) {
    console.error("Error handling message:", err.response ? JSON.stringify(err.response.data) : err.message);
    res.sendStatus(200);
  }
});

// WhatsApp pe reply bhejne ka function
async function sendMessage(to, body) {
  await axios.post(
    `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

app.get("/", (req, res) => {
  res.send("Restaurant bot chal raha hai ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server chal raha hai port ${PORT} par`);
});
