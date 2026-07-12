// Karachi Noor Biryani & Murgh Pulao - WhatsApp Order Bot
// Yeh code Meta WhatsApp Cloud API use karta hai

const express = require("express");
const axios = require("axios");

const app = express();
app.use(express.json());

// ============================================
// SETTINGS - Yeh values Render.com pe "Environment Variables" mein daalni hain
// ============================================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ummatfoods123"; // koi bhi word chun len, Meta setup mein bhi yehi likhna hoga
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN; // Meta se milne wala Access Token
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID; // Meta se milne wala Phone Number ID

// ============================================
// MENU - Yahan apna asli menu daal len (naam aur price)
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

// Payment ke details - yahan apne asli numbers daal len
const PAYMENT_INFO = {
  jazzcash: "0300-5583968",
  easypaisa: "0300-5583968",
  accountTitle: "Ummat Foods",
};

// Har customer ka order yaad rakhne ke liye (simple memory storage)
const sessions = {};

function getSession(phone) {
  if (!sessions[phone]) {
    sessions[phone] = { stage: "menu", cart: [], address: "" };
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

// ============================================
// WEBHOOK VERIFICATION - Meta pehli baar connect karte waqt yeh check karta hai
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
// MESSAGE HANDLING - Jab customer message bhejta hai
// ============================================
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry && req.body.entry[0];
    const change = entry && entry.changes && entry.changes[0];
    const value = change && change.value;
    const message = value && value.messages && value.messages[0];

    if (!message) {
      return res.sendStatus(200); // status update ya kuch aur, ignore kar den
    }

    const from = message.from; // customer ka number
    const text = (message.text && message.text.body || "").trim();
    const lower = text.toLowerCase();

    const session = getSession(from);
    let reply = "";

    // Naya customer ya "menu"/"hi" likhne pe menu dikhao
    if (session.stage === "menu" || lower === "menu" || lower === "hi" || lower === "hello" || lower === "salam") {
      reply = menuText();
      session.stage = "ordering";
    }
    // Order lena: "1x2" jaise format
    else if (session.stage === "ordering" && /^\d+x\d+$/.test(lower)) {
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
    }
    // Order complete - address maango
    else if (session.stage === "ordering" && lower === "done") {
      if (session.cart.length === 0) {
        reply = "Aapne abhi tak kuch order nahi kiya. Pehle item number likhein, jaise *1x2*.";
      } else {
        session.stage = "address";
        reply = `${cartText(session.cart)}\n\nAb apna delivery address likh dein.`;
      }
    }
    // Address le kar payment info do
    else if (session.stage === "address") {
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
        `Payment karne ke baad screenshot yahan bhej dein. Order confirm hote hi delivery shuru ho jayegi. Shukriya! 🙏`;
      session.stage = "waiting_payment";
    }
    // Payment screenshot ya confirmation ka intezaar
    else if (session.stage === "waiting_payment") {
      if (message.type === "image") {
        reply = "✅ Payment screenshot mil gayi hai. Aapka order confirm ho gaya hai — jald hi delivery shuru hogi. Shukriya! 🍛";
        // Naya order shuru karne ke liye session reset
        delete sessions[from];
      } else {
        reply = "Hum aapki payment screenshot ka intezaar kar rahe hain. Bhej dein taake order confirm ho jaye.";
      }
    }
    // Default - samajh nahi aaya
    else {
      reply = "Maaf kijiye, samajh nahi aaya. Menu dekhne ke liye *menu* likhein.";
    }

    await sendMessage(from, reply);
    res.sendStatus(200);
  } catch (err) {
    console.error("Error handling message:", err.response ? JSON.stringify(err.response.data) : err.message);
    res.sendStatus(200); // Meta ko hamesha 200 bhejna zaroori hai, warna woh retry karta rehta hai
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

// Server check karne ke liye simple route
app.get("/", (req, res) => {
  res.send("Restaurant bot chal raha hai ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server chal raha hai port ${PORT} par`);
});
