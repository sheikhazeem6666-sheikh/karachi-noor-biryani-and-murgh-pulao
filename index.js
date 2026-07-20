// Karachi Noor Biryani & Murgh Pulao - WhatsApp Order Bot
// Yeh code Meta WhatsApp Cloud API + Firebase Firestore use karta hai
// Features: Menu/Order, Payment, Automatic Rider Assignment, Delivery Tracking, Location Forwarding

const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");
const { getHaikuReply, verifyPaymentScreenshot } = require('./haiku-integration');

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
const countersRef = db.collection("meta").doc("counters");

// Order ka agla serial number nikalta hai (1, 2, 3...) — transaction safe hai
// taake ek sath 2 orders aayen to bhi number duplicate na ho
async function getNextOrderNumber() {
  return await db.runTransaction(async (t) => {
    const snap = await t.get(countersRef);
    const current = snap.exists && typeof snap.data().orderNumber === "number" ? snap.data().orderNumber : 0;
    const next = current + 1;
    t.set(countersRef, { orderNumber: next }, { merge: true });
    return next;
  });
}

// Order ka time Pakistan ke format mein readable banata hai (jaise "8:49 PM, 19 Jul")
function formatOrderTime(date) {
  return date.toLocaleString("en-PK", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    day: "2-digit",
    month: "short",
  });
}

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
    sessions[phone] = { stage: "menu", cart: [], address: "", customerName: "", aiHistory: [] };
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

function formatPhoneForMsg(phone) {
  let s = String(phone).replace(/\D/g, "");
  if (s.startsWith("92")) s = "0" + s.slice(2);
  return s;
}

// WhatsApp se image download kar ke base64 mein convert karta hai
async function downloadWhatsAppMedia(mediaId) {
  const metaRes = await axios.get(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const { url, mime_type } = metaRes.data;

  const fileRes = await axios.get(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    responseType: "arraybuffer",
  });

  return { base64: Buffer.from(fileRes.data).toString("base64"), mimeType: mime_type };
}

// Do phone numbers ke aakhri digits compare karta hai (formatting farq nazarandaz kar ke)
function numbersRoughlyMatch(a, b) {
  if (!a || !b) return false;
  const da = String(a).replace(/\D/g, "");
  const db = String(b).replace(/\D/g, "");
  if (da.length < 7 || db.length < 7) return false;
  return da.slice(-9) === db.slice(-9) || da.endsWith(db.slice(-9)) || db.endsWith(da.slice(-9));
}

// Payment screenshot download + verify karta hai aur order ke amount/number se match karta hai
// Returns { ok: true } agar sab theek hai, warna { ok: false, reason: "..." }
async function checkPaymentScreenshot(message, expectedAmount) {
  // ============================================
  // WAQTI TOR PAR RESTRICTIONS HATAI GAYI HAIN (temporary bypass)
  // Ab koi bhi image bhejne par payment turant accept ho jayegi.
  // Amount/account-number/date verification abhi OFF hai.
  // Dubara ON karne ke liye neeche wala commented block use karein
  // aur ye "return { ok: true };" line hata dein.
  // ============================================
  return { ok: true };

  /* ORIGINAL VERIFICATION LOGIC — dubara chalu karne ke liye is comment ko hatayein:
  try {
    const { base64, mimeType } = await downloadWhatsAppMedia(message.image.id);
    const result = await verifyPaymentScreenshot(base64, mimeType);

    if (result.verifyFailed) {
      return { ok: true };
    }

    if (!result.isPaymentScreenshot) {
      return { ok: false, reason: "Yeh payment screenshot nahi lag rahi. Please JazzCash/Easypaisa ki confirmation screenshot bhejein." };
    }

    if (result.amount !== null && result.amount !== undefined) {
      const diff = Math.abs(Number(result.amount) - Number(expectedAmount));
      if (isNaN(diff) || diff > 1) {
        return { ok: false, reason: `Screenshot mein amount Rs. ${result.amount} hai, lekin aapke order ki total amount Rs. ${expectedAmount} hai. Please sahi screenshot bhejein.` };
      }
    }

    if (result.accountNumber) {
      const matchesJazzcash = numbersRoughlyMatch(result.accountNumber, PAYMENT_INFO.jazzcash);
      const matchesEasypaisa = numbersRoughlyMatch(result.accountNumber, PAYMENT_INFO.easypaisa);
      if (!matchesJazzcash && !matchesEasypaisa) {
        return { ok: false, reason: "Yeh payment humare JazzCash/Easypaisa number pe nahi gayi lagti. Please sahi number pe payment ki screenshot bhejein." };
      }
    }

    if (result.dateTime) {
      const parsed = new Date(result.dateTime);
      if (!isNaN(parsed.getTime())) {
        const hoursOld = (Date.now() - parsed.getTime()) / (1000 * 60 * 60);
        if (hoursOld > 48) {
          return { ok: false, reason: "Yeh screenshot purani lag rahi hai. Please abhi ki payment ki screenshot bhejein." };
        }
      }
    }

    return { ok: true };
  } catch (err) {
    console.error("Payment screenshot check failed:", err.message);
    return { ok: true };
  }
  */
}

// Rider ka number + live location customer ko automatically bhejta hai
async function notifyCustomerOfRiderLocation(riderId, riderData) {
  const orderId = riderData.activeOrderId;
  if (!orderId) return;

  const orderSnap = await ordersRef.doc(orderId).get();
  if (!orderSnap.exists) return;
  const order = orderSnap.data();
  if (!order.customerPhone) return;

  const riderPhoneDisplay = formatPhoneForMsg(riderId);
  let msg = `🛵 *${riderData.name || "Aapka rider"}* aapki delivery ke liye nikal chuke hain.\nNumber: ${riderPhoneDisplay}`;

  if (typeof riderData.lat === "number" && typeof riderData.lng === "number") {
    msg += `\nLive Location: ${mapsLink(riderData.lat, riderData.lng)}`;
  }

  await sendMessage(order.customerPhone, msg);
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
  const orderNumber = await getNextOrderNumber();
  const orderTimeDate = new Date();
  const orderTimeText = formatOrderTime(orderTimeDate);

  // Pehle order record bana lo (rider abhi tak pata nahi)
  const orderRef = await ordersRef.add({
    orderNumber,
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
    const riderDisplayName = assignedRider.name || "Rider";

    await orderRef.update({
      status: "assigned",
      riderPhone: assignedRider.id,
      riderName: riderDisplayName,
    });

    const riderMsg =
      `🛵 *Naya Order Assign Hua*\n\n` +
      `*Order #${orderNumber}*\n` +
      `Order Time: ${orderTimeText}\n\n` +
      `${cartText(session.cart)}\n\n` +
      `Address: ${session.address}\n` +
      `Customer Number: ${customerPhone}\n\n` +
      `⚠️ Agar aapke paas pehle se koi purana order hai, to usse pehle deliver karein.\n\n` +
      `Jab order pick kar lein to reply karein: *1*\n` +
      `Jab deliver ho jaye to reply karein: *2*`;
    await sendMessage(assignedRider.id, riderMsg);

    // NOTE: Yahan pehle rider ki location turant customer ko bhej di jati thi —
    // lekin wo purani/stale location hoti thi kyunki rider ne abhi tak order
    // pick nahi kiya hota. Ab location sirf tab bhejenge jab rider "1" (picked up)
    // reply kare — dekhein handleRiderReply() function mein.

    return `✅ *Payment Accepted!* Aapka order (Order #${orderNumber}) confirm ho gaya hai — *${riderDisplayName}* aapki delivery ke liye assign ho gaye hain. Jald hi pahunch jayega! 🍛`;
  } else {
    return `✅ *Payment Accepted!* Order (Order #${orderNumber}) confirm ho gaya hai — filhal hamare riders busy hain, jaise hi koi free hota hai order assign kar diya jayega. Shukriya! 🙏`;
  }
}

// Customer ko uske rider ki live location bhejta hai (jab customer poochta hai)
async function getRiderLocationReply(customerPhone) {
  const snap = await ordersRef
    .where("customerPhone", "==", customerPhone)
    .where("status", "in", ["assigned", "out_for_delivery"])
    .limit(1)
    .get();

  if (snap.empty) {
    return "Filhal aapka koi aisa order nahi hai jo delivery ke liye nikla ho.";
  }

  const order = snap.docs[0].data();
  if (!order.riderPhone) {
    return "Aapka order abhi kisi rider ko assign nahi hua. Jald hi assign ho jayega.";
  }

  const riderDoc = await ridersRef.doc(order.riderPhone).get();
  if (!riderDoc.exists || typeof riderDoc.data().lat !== "number") {
    return `🛵 *${riderDoc.exists ? (riderDoc.data().name || "Aapka rider") : "Aapka rider"}* aapki delivery ke liye nikal chuke hain, filhal live location available nahi hai.`;
  }

  const rider = riderDoc.data();
  const link = mapsLink(rider.lat, rider.lng);
  return `🛵 *${rider.name || "Aapka rider"}* is waqt yahan hain:\n${link}\n\nJald hi aap tak pahunch jayenge!`;
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

    const riderPhoneDisplay = formatPhoneForMsg(riderId);
    let customerMsg =
      `🛵 Aapka order${order.orderNumber ? ` (Order #${order.orderNumber})` : ""} out for delivery hai!\n\n` +
      `Rider: *${rider.name || "N/A"}*\n` +
      `Number: ${riderPhoneDisplay}`;

    if (typeof rider.lat === "number" && typeof rider.lng === "number") {
      customerMsg += `\nLive Location: ${mapsLink(rider.lat, rider.lng)}`;
    }

    customerMsg += `\n\nJald hi aap tak pahunch jayega!`;

    await sendMessage(order.customerPhone, customerMsg);
    return "✅ Status update ho gaya: Out for Delivery. Customer ko aapka number aur location bhej di gayi hai.";
  }

  if (text === "2") {
    await ordersRef.doc(orderId).update({ status: "delivered" });
    await ridersRef.doc(riderId).update({ status: "available", activeOrderId: admin.firestore.FieldValue.delete() });
    await sendMessage(order.customerPhone, "✅ Aapka order deliver ho gaya hai. Khaane ka mazaa lein! 🍛 Shukriya Karachi Noor Biryani & Murgh Pulao choose karne ke liye.");
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
      // Agar rider ne apni location bheji hai, to Firestore mein save kar do (live tracking ke liye)
      if (message.type === "location") {
        const { latitude, longitude } = message.location;
        await ridersRef.doc(from).update({
          lat: latitude,
          lng: longitude,
          locationUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Agar is rider ke pass active order hai, to customer ko turant number+location bhej do
        const riderData = riderDoc.data();
        if (riderData.activeOrderId) {
          await notifyCustomerOfRiderLocation(from, { ...riderData, lat: latitude, lng: longitude });
        }

        await sendMessage(from, "📍 Aapki location update ho gayi hai. Shukriya!");
        return res.sendStatus(200);
      }

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

    // Customer apne rider ki location poochh raha hai
    const trackingKeywords = ["track", "kahan", "kaha", "kidhar", "location"];
    if (trackingKeywords.some((k) => lower.includes(k))) {
      reply = await getRiderLocationReply(from);
      await sendMessage(from, reply);
      return res.sendStatus(200);
    }

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
        const total = cartTotal(session.cart);
        const check = await checkPaymentScreenshot(message, total);
        if (check.ok) {
          await notifyStaffDineIn(session.tableNumber, session.customerName, session.cart);
          reply = `✅ *Payment Accepted!* ${session.customerName}, aapka order kitchen ko bhej diya gaya hai — *Table ${session.tableNumber}*. Taiyar hote hi table pe pahunch jayega. Shukriya! 🍛`;
          delete sessions[from];
        } else {
          reply = `⚠️ ${check.reason}`;
        }
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
        const total = cartTotal(session.cart);
        const check = await checkPaymentScreenshot(message, total);
        if (check.ok) {
          reply = await assignRiderToOrder(from, session);
          delete sessions[from];
        } else {
          reply = `⚠️ ${check.reason}`;
        }
      } else {
        reply = "Hum aapki payment screenshot ka intezaar kar rahe hain. Bhej dein taake order confirm ho jaye.";
      }
    } else {
     reply = await getHaikuReply(text, session.aiHistory);
     session.aiHistory.push({ role: "user", content: text });
     session.aiHistory.push({ role: "assistant", content: reply });
     // Sirf pichli 10 baatein yaad rakho, taake message zyada bada na ho
     if (session.aiHistory.length > 20) {
       session.aiHistory = session.aiHistory.slice(-20);
     }
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
