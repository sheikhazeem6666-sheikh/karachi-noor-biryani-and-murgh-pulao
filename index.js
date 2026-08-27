// ============================================
// ULTIMATE PRODUCTION CODE
// Karachi Noor Biryani & Murgh Pulao
// WhatsApp Bot + Dashboard Integrated
// UPDATED: Broadcast-and-claim rider model
//   - Riders are NEVER marked "busy" and blocked from new orders.
//   - Every new/reassigned order is broadcast to ALL on-duty riders.
//   - A rider claims an order by replying 1/<orderNumber> (or a range
//     like 1/1_7 to claim several at once). First rider to claim wins
//     (Firestore transaction), everyone else gets "already taken".
//   - 2/<orderNumber> = out for delivery, 3/<orderNumber> = delivered.
//   - Bare "1" = rider signaling "I'm at the restaurant, waiting" (no
//     specific order attached, informational only).
// ============================================

const express = require("express");
const axios = require("axios");
const admin = require("firebase-admin");
const { getHaikuReply } = require('./haiku-integration');

const app = express();
app.use(express.json({ limit: '10mb' }));

// ============================================
// ENVIRONMENT
// ============================================
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "ummatfoods123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const FIREBASE_SERVICE_ACCOUNT_KEY = process.env.FIREBASE_SERVICE_ACCOUNT_KEY;
const STAFF_NUMBER = process.env.STAFF_NUMBER;
const DASHBOARD_WEBHOOK = process.env.DASHBOARD_WEBHOOK || null;

// ============================================
// FIREBASE
// ============================================
admin.initializeApp({
  credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT_KEY)),
});
const db = admin.firestore();

// ============================================
// CONFIG
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

// Max orders a rider can claim in a single range command (safety cap,
// not a "how many can he hold" cap — that stays unlimited).
const MAX_RANGE_CLAIM = 50;

// If nobody claims a broadcast order within this window, we re-broadcast
// once and alert staff so a human can chase it up.
const UNCLAIMED_REBROADCAST_MS = 5 * 60 * 1000;

// If a rider already has this many active orders and tries to claim more,
// we ask them to confirm once (soft warning, not a hard block) — protects
// against someone accidentally claiming way more than they can deliver.
const ACTIVE_ORDER_WARNING_THRESHOLD = 5;
const CLAIM_CONFIRM_TTL_MS = 2 * 60 * 1000;
// riderId -> { spec, expiresAt } — pending "are you sure" for one claim command.
const riderPendingClaims = new Map();

// A pending_rider order nobody claims after this long is auto-expired so it
// doesn't sit forever looking "live" on the dashboard.
const ORDER_EXPIRE_MS = 2 * 60 * 60 * 1000;

// NEW: An "assigned" order that sits with a rider too long without them
// picking it up gets flagged to staff so a human can step in.
const STUCK_ORDER_ALERT_MS = 45 * 60 * 1000;

// ============================================
// STATE MANAGEMENT
// ============================================
const sessions = {};
const processedMessages = new Set();

// Cleanup every hour
setInterval(() => {
  if (processedMessages.size > 10000) processedMessages.clear();

  const now = Date.now();
  for (const [phone, session] of Object.entries(sessions)) {
    if (session.lastActivity && (now - session.lastActivity) > 24 * 60 * 60 * 1000) {
      delete sessions[phone];
      db.collection("sessions").doc(phone).delete().catch(() => {});
    }
  }

  // Clean up any expired "are you sure you want to claim more" prompts.
  for (const [riderId, pending] of riderPendingClaims.entries()) {
    if (pending.expiresAt <= now) riderPendingClaims.delete(riderId);
  }

  expireStalePendingOrders().catch(() => {});
  alertStuckOrders().catch(() => {}); // NEW
}, 60 * 60 * 1000);

// ============================================
// CORE HELPERS
// ============================================

async function firestoreOperation(operation, retries = 3) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await operation();
    } catch (err) {
      lastError = err;
      if ([4, 8, 14].includes(err.code)) {
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000 + Math.random() * 1000));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

async function getSession(phone) {
  if (sessions[phone]) {
    sessions[phone].lastActivity = Date.now();
    return sessions[phone];
  }
  try {
    const doc = await firestoreOperation(() =>
      db.collection("sessions").doc(phone).get()
    );
    if (doc.exists) {
      sessions[phone] = { ...doc.data(), lastActivity: Date.now() };
      return sessions[phone];
    }
  } catch {}
  sessions[phone] = {
    stage: "menu",
    cart: [],
    address: "",
    customerName: "",
    aiHistory: [],
    lastActivity: Date.now(),
    createdAt: Date.now()
  };
  return sessions[phone];
}

async function saveSession(phone, session) {
  session.lastActivity = Date.now();
  sessions[phone] = session;
  try {
    await firestoreOperation(() =>
      db.collection("sessions").doc(phone).set(session, { merge: true })
    );
  } catch {}
}

async function clearSession(phone) {
  delete sessions[phone];
  try {
    await firestoreOperation(() =>
      db.collection("sessions").doc(phone).delete()
    );
  } catch {}
}

async function getNextOrderNumber() {
  return await firestoreOperation(async () => {
    return await db.runTransaction(async (t) => {
      const snap = await t.get(db.collection("meta").doc("counters"));
      const current = snap.exists && typeof snap.data().orderNumber === "number"
        ? snap.data().orderNumber
        : 0;
      const next = current + 1;
      t.set(db.collection("meta").doc("counters"), { orderNumber: next }, { merge: true });
      return next;
    });
  });
}

function formatOrderTime(date) {
  return date.toLocaleString("en-PK", {
    timeZone: "Asia/Karachi",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    day: "2-digit",
    month: "short",
  });
}

function menuText() {
  let text = "🍛 *Karachi Noor Biryani & Murgh Pulao*\n\nAssalam-o-Alaikum! Khush aamdeed. Neeche menu hai:\n\n";
  MENU.forEach((item) => {
    text += `${item.id}. ${item.name} - Rs. ${item.price}\n`;
  });
  text += "\nOrder karne ke liye item ka number aur quantity likhein.\nMisaal: *1x2* (matlab Chicken Biryani, 2 plates)\n\nGalti theek karni ho to wahi number dobara likhein (jaise *1x3*), ya *remove 1* likh kar item hatayen. *cart* likh kar order dekhein.\n\nJab order mukammal ho jaye to *done* likh dein.";
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

function normalizePhoneForLookup(input) {
  let s = String(input).replace(/\D/g, "");
  if (s.startsWith("0")) s = "92" + s.slice(1);
  if (!s.startsWith("92")) s = "92" + s;
  return s;
}

// ============================================
// LOYALTY POINTS
// ============================================
async function addLoyaltyPoints(phone, amount) {
  try {
    const points = Math.floor(amount / 100);
    const userRef = db.collection("customers").doc(phone);
    await userRef.set({
      phone,
      loyaltyPoints: admin.firestore.FieldValue.increment(points),
      lastOrderAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    const user = await userRef.get();
    if (user.exists && user.data().loyaltyPoints >= 10) {
      await sendMessage(phone,
        `🎉 *Congratulations!* Aapke 10 loyalty points ho gaye!\n` +
        `Agli order par Rs.50 discount milega. *discount* likh kar claim karein.`
      );
    }
    return points;
  } catch {
    return 0;
  }
}

// ============================================
// CUSTOMER PROFILE (persistent memory across orders)
// ============================================
async function saveCustomerProfile(phone, fields) {
  try {
    await firestoreOperation(() =>
      db.collection("customers").doc(phone).set({
        phone,
        ...fields,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true })
    );
  } catch {}
}

async function getCustomerProfile(phone) {
  try {
    const doc = await firestoreOperation(() => db.collection("customers").doc(phone).get());
    return doc.exists ? doc.data() : null;
  } catch {
    return null;
  }
}

// ============================================
// RIDER FUNCTIONS
// ============================================
// A rider's true "current workload" is whatever the orders collection says is still
// assigned to them — not a single activeOrderId field. Riders can now hold many
// concurrent orders, so this is the source of truth everywhere (issue handoffs,
// stats, broadcasts).
async function getRiderActiveOrders(riderId) {
  try {
    const snap = await firestoreOperation(() =>
      db.collection("orders")
        .where("riderPhone", "==", riderId)
        .where("status", "in", ["assigned", "out_for_delivery"])
        .get()
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    return [];
  }
}

async function getRiderDeliveredCount(riderId) {
  try {
    const snap = await firestoreOperation(() =>
      db.collection("orders")
        .where("riderPhone", "==", riderId)
        .where("status", "==", "delivered")
        .get()
    );
    return snap.size;
  } catch {
    return null;
  }
}

// "On duty" riders are the ones eligible to receive broadcasts. We reuse the
// existing `status` field on the riders doc ("available" = on duty). Riders
// are NEVER flipped to "busy" by the system anymore — only a rider explicitly
// going off duty (or a genuine issue report) removes them from broadcasts.
async function getOnDutyRiders() {
  try {
    const snap = await firestoreOperation(() =>
      db.collection("riders").where("status", "==", "available").get()
    );
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch {
    return [];
  }
}

function orderBroadcastText(orderData, orderNumber) {
  return (
    `🆕 *Naya Order Available*\n\n` +
    `*Order #${orderNumber}*\n` +
    `${cartText(orderData.cart)}\n\n` +
    `Address: ${orderData.address}\n\n` +
    `Lena ho to reply karein: *1/${orderNumber}*\n` +
    `(Ek se zyada orders ek sath lene ho to range bhi likh sakte hain, jaise *1/${orderNumber}_${orderNumber + 2}*)`
  );
}

// Sends the order to every on-duty rider. Whoever replies 1/<orderNumber>
// first actually gets it (claimOrderByNumber below handles the race via a
// Firestore transaction) — everyone else's claim attempt will just fail
// gracefully with "already taken".
async function broadcastOrderToRiders(orderData, orderNumber, excludeRiderId) {
  const riders = await getOnDutyRiders();
  const text = orderBroadcastText(orderData, orderNumber);
  await Promise.all(
    riders
      .filter(r => r.id !== excludeRiderId)
      .map(r => sendMessage(r.id, text))
  );
  return riders.length;
}

// Atomically claims ONE order number for a rider. Fails (returns success:false)
// if the order doesn't exist, isn't awaiting a rider, or was already claimed.
async function claimOrderByNumber(riderId, riderName, orderNumber) {
  try {
    return await db.runTransaction(async (t) => {
      const snap = await t.get(
        db.collection("orders").where("orderNumber", "==", orderNumber).limit(1)
      );
      if (snap.empty) return { success: false, reason: "not_found" };
      const doc = snap.docs[0];
      const order = doc.data();
      if (order.status !== "pending_rider") {
        return {
          success: false,
          reason: order.riderPhone === riderId ? "already_yours" : "taken"
        };
      }
      t.update(doc.ref, {
        status: "assigned",
        riderPhone: riderId,
        riderName: riderName || "Rider",
        assignedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      return { success: true, orderId: doc.id, order };
    });
  } catch {
    return { success: false, reason: "error" };
  }
}

function parseOrderNumberRange(spec) {
  // spec like "7" or "1_7"
  const m = spec.match(/^(\d+)(?:_(\d+))?$/);
  if (!m) return null;
  const start = parseInt(m[1], 10);
  const end = m[2] ? parseInt(m[2], 10) : start;
  if (end < start) return null;
  if (end - start + 1 > MAX_RANGE_CLAIM) return null;
  const nums = [];
  for (let n = start; n <= end; n++) nums.push(n);
  return nums;
}

// Tells every other on-duty rider that an order (or set of orders) they may
// have seen in a broadcast is no longer available — so their phone doesn't
// keep showing something as claimable when it's already gone.
async function notifyOtherRidersOrdersTaken(orderNumbers, claimedByRiderId) {
  try {
    const riders = await getOnDutyRiders();
    const others = riders.filter(r => r.id !== claimedByRiderId);
    if (!others.length) return;
    const text = orderNumbers.length === 1
      ? `ℹ️ Order #${orderNumbers[0]} le liya gaya hai (ab available nahi).`
      : `ℹ️ Orders ${orderNumbers.map(n => "#" + n).join(", ")} le liye gaye hain (ab available nahi).`;
    await Promise.all(others.map(r => sendMessage(r.id, text).catch(() => {})));
  } catch {}
}

// Handles "1/<n>" and "1/<start>_<end>" — claiming one or many orders.
async function handleClaimCommand(riderId, riderData, spec) {
  const orderNumbers = parseOrderNumberRange(spec);
  if (!orderNumbers) return "Order number(s) samajh nahi aaye. Misaal: *1/7* ya *1/1_7*.";

  // Soft warning if the rider is already juggling a lot of active orders —
  // require them to resend the same command once to confirm.
  // NOTE: checks (current + about-to-claim) total, not just current, so a
  // rider jumping from e.g. 4 active straight to 12 also gets warned.
  const currentActive = await getRiderActiveOrders(riderId);
  if (currentActive.length + orderNumbers.length >= ACTIVE_ORDER_WARNING_THRESHOLD) {
    const pending = riderPendingClaims.get(riderId);
    const alreadyConfirmed = pending && pending.spec === spec && pending.expiresAt > Date.now();
    if (!alreadyConfirmed) {
      riderPendingClaims.set(riderId, { spec, expiresAt: Date.now() + CLAIM_CONFIRM_TTL_MS });
      return `⚠️ Aapke pass abhi *${currentActive.length}* active orders hain aur *${orderNumbers.length}* aur lena chahte hain (total ${currentActive.length + orderNumbers.length}). Pakka *1/${spec}* lena hai?\nConfirm karne ke liye yehi command dobara bhej dein: *1/${spec}*`;
    }
    riderPendingClaims.delete(riderId);
  }

  const claimed = [];
  const failed = [];
  for (const num of orderNumbers) {
    const result = await claimOrderByNumber(riderId, riderData.name, num);
    if (result.success) {
      claimed.push({ num, order: result.order, orderId: result.orderId });
      // Loyalty + analytics already happen at order-creation time, so nothing
      // extra to do here beyond notifying the customer and the dashboard.
      notifyDashboard({ ...result.order, id: result.orderId, event: "order_claimed", riderPhone: riderId, riderName: riderData.name || "Rider" });
      if (result.order.customerPhone) {
        sendMessage(
          result.order.customerPhone,
          `✅ Aapka order (Order #${num}) confirm ho gaya hai — *${riderData.name || "Rider"}* aapki delivery ke liye assign ho gaye hain. Jald hi pahunch jayega! 🍛`
        ).catch(() => {});
      }
    } else {
      failed.push(num);
    }
  }

  if (claimed.length) {
    notifyOtherRidersOrdersTaken(claimed.map(c => c.num), riderId).catch(() => {});
  }

  let msg = "";
  if (claimed.length) {
    msg += `✅ Aapne ${claimed.length === 1 ? `order #${claimed[0].num}` : `orders ${claimed.map(c => "#" + c.num).join(", ")}`} le liye hain.\n`;
    msg += `Restaurant se pick karne ke baad reply karein: *2/${claimed.length === 1 ? claimed[0].num : orderNumbers.join("_")}* (out for delivery)\n`;
  }
  if (failed.length) {
    msg += `⚠️ Yeh order(s) available nahi thay (pehle hi kisi aur ne le liye ya galat number): ${failed.join(", ")}`;
  }
  return msg || "Koi order claim nahi ho saka.";
}

// ============================================
// ORDER CREATION (payment accepted) — now always broadcasts,
// never blocks or waits on a single "available" rider.
// ============================================
async function createOrderAndBroadcast(customerPhone, session) {
  const total = cartTotal(session.cart);
  const orderNumber = await getNextOrderNumber();
  const orderTimeDate = new Date();
  const orderTimeText = formatOrderTime(orderTimeDate);

  const orderData = {
    orderNumber,
    customerPhone,
    cart: session.cart,
    total,
    address: session.address,
    status: "pending_rider",
    riderPhone: null,
    riderName: null,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAtReadable: orderTimeText,
    customerName: session.customerName || null,
  };

  const orderRef = await firestoreOperation(() => db.collection("orders").add(orderData));

  // Keep a durable customer profile (name + last address) so we remember returning customers
  await saveCustomerProfile(customerPhone, {
    name: session.customerName || null,
    lastAddress: session.address || null,
  });

  notifyDashboard({ ...orderData, id: orderRef.id, event: 'order_created' });

  // Award loyalty points and bump analytics at payment-acceptance time —
  // this no longer depends on whether a rider happens to be free right now.
  await addLoyaltyPoints(customerPhone, total);
  updateAnalytics();

  const ridersNotified = await broadcastOrderToRiders(orderData, orderNumber);

  // If nobody claims it in time, re-broadcast once and loop staff in.
  setTimeout(() => checkAndRebroadcastPendingOrder(orderRef.id, orderNumber), UNCLAIMED_REBROADCAST_MS);

  if (ridersNotified === 0 && STAFF_NUMBER) {
    sendMessage(STAFF_NUMBER, `⚠️ Order #${orderNumber} banaya gaya lekin filhal koi rider on-duty nahi hai.`).catch(() => {});
  }

  return `✅ *Payment Accepted!* Aapka order (Order #${orderNumber}) confirm ho gaya hai — riders ko notify kar diya gaya hai, jald hi koi rider assign ho jayega. Shukriya! 🙏`;
}

// Marks any order still sitting unclaimed ("pending_rider") past
// ORDER_EXPIRE_MS as "expired" so it stops looking like a live order on the
// dashboard, and lets staff know so a human can follow up with the customer.
// NOTE: this query needs a Firestore composite index on
// orders(status ASC, createdAt ASC) — Firestore will log a console error
// with a direct link to create it the first time this runs if it's missing.
async function expireStalePendingOrders() {
  try {
    const cutoff = new Date(Date.now() - ORDER_EXPIRE_MS);
    const snap = await firestoreOperation(() =>
      db.collection("orders")
        .where("status", "==", "pending_rider")
        .where("createdAt", "<=", cutoff)
        .ge
