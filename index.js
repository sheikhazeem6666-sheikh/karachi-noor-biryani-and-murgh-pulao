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
  const currentActive = await getRiderActiveOrders(riderId);
  if (currentActive.length >= ACTIVE_ORDER_WARNING_THRESHOLD) {
    const pending = riderPendingClaims.get(riderId);
    const alreadyConfirmed = pending && pending.spec === spec && pending.expiresAt > Date.now();
    if (!alreadyConfirmed) {
      riderPendingClaims.set(riderId, { spec, expiresAt: Date.now() + CLAIM_CONFIRM_TTL_MS });
      return `⚠️ Aapke pass abhi *${currentActive.length}* active orders hain. Pakka *1/${spec}* aur lena hai?\nConfirm karne ke liye yehi command dobara bhej dein: *1/${spec}*`;
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
        .get()
    );
    for (const doc of snap.docs) {
      const order = doc.data();
      await firestoreOperation(() =>
        doc.ref.update({ status: "expired", expiredAt: admin.firestore.FieldValue.serverTimestamp() })
      );
      notifyDashboard({ ...order, id: doc.id, event: "order_expired" });
      if (STAFF_NUMBER) {
        sendMessage(
          STAFF_NUMBER,
          `⚠️ Order #${order.orderNumber || "N/A"} ${Math.round(ORDER_EXPIRE_MS / 3600000)} ghante se koi rider claim nahi kar saka — expire kar diya gaya.\nCustomer: ${formatPhoneForMsg(order.customerPhone)}\nAddress: ${order.address || "N/A"}\n⚠️ Customer se rabta karke manually handle karein.`
        ).catch(() => {});
      }
    }
  } catch {}
}

async function checkAndRebroadcastPendingOrder(orderId, orderNumber) {
  try {
    const orderSnap = await firestoreOperation(() => db.collection("orders").doc(orderId).get());
    if (!orderSnap.exists) return;
    const order = orderSnap.data();
    if (order.status !== "pending_rider") return; // already claimed

    const ridersNotified = await broadcastOrderToRiders(order, orderNumber);
    if (STAFF_NUMBER) {
      sendMessage(
        STAFF_NUMBER,
        `⚠️ Order #${orderNumber} ${UNCLAIMED_REBROADCAST_MS / 60000} minute se pending hai (${ridersNotified} riders ko dobara notify kiya).`
      ).catch(() => {});
    }
  } catch {}
}

// A rider's lat/lng is only trustworthy for a short window after it was last updated.
// Otherwise we'd be showing a stale location from a previous delivery as if it were live.
const RIDER_LOCATION_FRESHNESS_MS = 15 * 60 * 1000;

function isRiderLocationFresh(riderData) {
  if (typeof riderData.lat !== "number" || typeof riderData.lng !== "number") return false;
  const updatedAt = riderData.locationUpdatedAt;
  if (!updatedAt || typeof updatedAt.toDate !== "function") return false;
  return (Date.now() - updatedAt.toDate().getTime()) <= RIDER_LOCATION_FRESHNESS_MS;
}

async function notifyCustomerOfRiderLocation(riderId, riderData) {
  // Rider may now have several active orders — update all their customers.
  const activeOrders = await getRiderActiveOrders(riderId);
  for (const order of activeOrders) {
    if (!order.customerPhone) continue;
    const riderPhoneDisplay = formatPhoneForMsg(riderId);
    let msg = `🛵 *${riderData.name || "Aapka rider"}* aapki delivery ke liye nikal chuke hain.\nNumber: ${riderPhoneDisplay}`;
    if (typeof riderData.lat === "number" && typeof riderData.lng === "number") {
      msg += `\nLive Location: ${mapsLink(riderData.lat, riderData.lng)}`;
    }
    await sendMessage(order.customerPhone, msg).catch(() => {});
  }
}

// Reassigns ONE order (used for rider-issue handoffs) by broadcasting it back
// out as pending_rider to every other on-duty rider — first to claim gets it.
async function reassignOrderToNewRider(orderId, oldRiderId) {
  try {
    const orderSnap = await firestoreOperation(() => db.collection("orders").doc(orderId).get());
    if (!orderSnap.exists) return null;
    const order = orderSnap.data();

    // Grab the old rider's last known location BEFORE we touch their doc, so we can
    // tell the new rider roughly where the order/food currently is.
    let oldRiderData = null;
    try {
      const oldRiderSnap = await firestoreOperation(() => db.collection("riders").doc(oldRiderId).get());
      if (oldRiderSnap.exists) oldRiderData = oldRiderSnap.data();
    } catch {}

    await firestoreOperation(() =>
      db.collection("orders").doc(orderId).update({
        status: "pending_rider",
        riderPhone: null,
        riderName: null,
        reassignedFrom: oldRiderId,
        reassignedAt: admin.firestore.FieldValue.serverTimestamp()
      })
    );
    notifyDashboard({ ...order, id: orderId, event: "order_reassigned", reassignedFrom: oldRiderId });

    let broadcastText = orderBroadcastText(order, order.orderNumber);
    if (oldRiderData && typeof oldRiderData.lat === "number" && typeof oldRiderData.lng === "number") {
      broadcastText =
        `⚠️ *Reassigned Order* — pichle rider (*${oldRiderData.name || "N/A"}*) ko raaste mein masla hua tha.\n` +
        `Unki last known location: ${mapsLink(oldRiderData.lat, oldRiderData.lng)}\n` +
        `Order/khana wahan se collect karna pad sakta hai.\n\n` + broadcastText;
    }
    const riders = (await getOnDutyRiders()).filter(r => r.id !== oldRiderId);
    await Promise.all(riders.map(r => sendMessage(r.id, broadcastText)));

    return { notified: riders.length };
  } catch {
    return null;
  }
}

async function getRiderLocationReply(customerPhone) {
  try {
    const snap = await firestoreOperation(() =>
      db.collection("orders")
        .where("customerPhone", "==", customerPhone)
        .where("status", "in", ["assigned", "out_for_delivery"])
        .limit(1)
        .get()
    );
    if (snap.empty) return "Filhal aapka koi aisa order nahi hai jo delivery ke liye nikla ho.";
    const order = snap.docs[0].data();
    if (!order.riderPhone) return "Aapka order abhi kisi rider ko assign nahi hua. Jald hi assign ho jayega.";

    const riderDoc = await firestoreOperation(() =>
      db.collection("riders").doc(order.riderPhone).get()
    );
    if (!riderDoc.exists) {
      return "🛵 Aapka rider assign ho chuka hai, filhal live location available nahi hai.";
    }
    const rider = riderDoc.data();
    if (!isRiderLocationFresh(rider)) {
      return `🛵 *${rider.name || "Aapka rider"}* aapki delivery ke liye assign hain, filhal unki taazah live location available nahi hai. Jaise hi rider apni location update karega, hum bhej denge.`;
    }
    return `🛵 *${rider.name || "Aapka rider"}* is waqt yahan hain:\n${mapsLink(rider.lat, rider.lng)}\n\nJald hi aap tak pahunch jayenge!`;
  } catch {
    return "Location fetch karne mein masla aaya. Thodi dair baad try karein.";
  }
}

async function forwardLocationToRider(customerPhone, lat, lng) {
  try {
    const snap = await firestoreOperation(() =>
      db.collection("orders")
        .where("customerPhone", "==", customerPhone)
        .where("status", "in", ["assigned", "out_for_delivery"])
        .limit(1)
        .get()
    );
    if (snap.empty) return false;
    const order = snap.docs[0].data();
    if (!order.riderPhone) return false;
    await sendMessage(order.riderPhone, `📍 Customer ne apni location share ki hai:\n${mapsLink(lat, lng)}`);
    return true;
  } catch {
    return false;
  }
}

// ============================================
// DELIVERY STATUS TRANSITIONS (per order, keyed by order number now)
// ============================================
async function markOneOrderOutForDelivery(riderId, riderData, orderNumber) {
  const snap = await firestoreOperation(() =>
    db.collection("orders").where("orderNumber", "==", orderNumber).limit(1).get()
  );
  if (snap.empty) return `Order #${orderNumber} nahi mila.`;
  const doc = snap.docs[0];
  const order = doc.data();
  if (order.riderPhone !== riderId) return `Order #${orderNumber} aapko assign nahi hai.`;
  if (order.status !== "assigned") return `Order #${orderNumber} is waqt "out for delivery" mark nahi ho sakta (status: ${order.status}).`;

  await firestoreOperation(() =>
    doc.ref.update({ status: "out_for_delivery", pickedUpAt: admin.firestore.FieldValue.serverTimestamp() })
  );
  notifyDashboard({ ...order, id: doc.id, event: "order_out_for_delivery", riderPhone: riderId, riderName: riderData.name || "Rider" });
  const riderPhoneDisplay = formatPhoneForMsg(riderId);
  let customerMsg =
    `🛵 Aapka order (Order #${orderNumber}) out for delivery hai!\n\n` +
    `Rider: *${riderData.name || "N/A"}*\n` +
    `Number: ${riderPhoneDisplay}`;
  if (isRiderLocationFresh(riderData)) {
    customerMsg += `\nLive Location: ${mapsLink(riderData.lat, riderData.lng)}`;
  }
  customerMsg += `\n\nJald hi aap tak pahunga jayega!`;
  await sendMessage(order.customerPhone, customerMsg);
  return `✅ Order #${orderNumber}: Out for Delivery mark ho gaya.`;
}

async function markOneOrderDeliveredPending(riderId, orderNumber) {
  const snap = await firestoreOperation(() =>
    db.collection("orders").where("orderNumber", "==", orderNumber).limit(1).get()
  );
  if (snap.empty) return `Order #${orderNumber} nahi mila.`;
  const doc = snap.docs[0];
  const order = doc.data();
  if (order.riderPhone !== riderId) return `Order #${orderNumber} aapko assign nahi hai.`;
  if (order.status !== "out_for_delivery") return `Order #${orderNumber} abhi "out for delivery" nahi hai (status: ${order.status}). Pehle *2/${orderNumber}* karein.`;

  await firestoreOperation(() =>
    doc.ref.update({ status: "delivered_pending_confirmation", deliveredAt: admin.firestore.FieldValue.serverTimestamp() })
  );
  notifyDashboard({ ...order, id: doc.id, event: "order_delivered_pending_confirmation", riderPhone: riderId });
  await sendMessage(
    order.customerPhone,
    `✅ Aapka order (Order #${orderNumber}) deliver kar diya gaya hai (rider ne confirm kiya hai).\n\n` +
      `Agar order sahi salamat mil gaya hai to reply karein: *yes*\n` +
      `Agar order nahi mila ya koi masla hai to reply karein: *no*`
  );
  return `✅ Order #${orderNumber}: Delivered mark ho gaya — customer se confirmation ka intezar hai (yes/no).`;
}

// Runs a 2/<n> or 3/<n> (or range) command across one or more order numbers.
async function handleStatusCommand(riderId, riderData, action, spec) {
  const orderNumbers = parseOrderNumberRange(spec);
  if (!orderNumbers) return "Order number(s) samajh nahi aaye. Misaal: *2/7* ya *2/1_7*.";

  const results = [];
  for (const num of orderNumbers) {
    const msg = action === "2"
      ? await markOneOrderOutForDelivery(riderId, riderData, num)
      : await markOneOrderDeliveredPending(riderId, num);
    results.push(msg);
  }
  return results.join("\n");
}

// ============================================
// RIDER REPLY HANDLER
// ============================================
async function handleRiderReply(riderId, text) {
  try {
    const riderDoc = await firestoreOperation(() =>
      db.collection("riders").doc(riderId).get()
    );
    if (!riderDoc.exists) return null;
    const rider = riderDoc.data();
    const lower = text.trim().toLowerCase();

    if (lower === "free" || lower === "available" || lower === "on") {
      await firestoreOperation(() =>
        db.collection("riders").doc(riderId).update({ status: "available" })
      );
      return "✅ Aap ab *on-duty* hain aur naye orders receive karenge.";
    }

    if (lower === "off" || lower === "offline" || lower === "break") {
      await firestoreOperation(() =>
        db.collection("riders").doc(riderId).update({ status: "off_duty" })
      );
      return "🛑 Aap *off-duty* ho gaye hain, naye orders nahi milenge. *free* likh kar wapis on ho sakte hain.";
    }

    // Bare "1" — informational: rider is at the restaurant, waiting (no
    // specific order attached).
    if (text.trim() === "1") {
      return "👍 Theek hai, aap restaurant par intezar kar rahe hain. Jab koi specific order lena ho to *1/<order number>* likhein.";
    }

    // 1/<n>, 1/<start>_<end>  = claim
    // 2/<n>, 2/<start>_<end>  = out for delivery
    // 3/<n>, 3/<start>_<end>  = delivered
    const cmdMatch = text.trim().match(/^([123])\s*\/\s*(\d+(?:_\d+)?)$/);
    if (cmdMatch) {
      const action = cmdMatch[1];
      const spec = cmdMatch[2];
      if (action === "1") return await handleClaimCommand(riderId, rider, spec);
      return await handleStatusCommand(riderId, rider, action, spec);
    }

    if (["record", "mera record", "meray order", "meray orders"].includes(lower)) {
      const deliveredCount = await getRiderDeliveredCount(riderId);
      const pending = await getRiderActiveOrders(riderId);
      let msg = deliveredCount !== null ? `📦 Aapne ab tak *${deliveredCount}* orders deliver kiye hain.\n` : "";
      msg += pending.length
        ? `Filhal pending: ${pending.map(o => `#${o.orderNumber || "N/A"}`).join(", ")}`
        : "Filhal koi pending order nahi hai.";
      return msg;
    }

    // Anything else while a rider has (or doesn't have) active orders is
    // treated as an issue report (petrol, tyre, accident, etc).
    const activeOrders = await getRiderActiveOrders(riderId);
    const issueResult = await fileRiderIssue(riderId, rider, text, activeOrders);

    if (issueResult.urgent) {
      for (const activeOrder of activeOrders) {
        const reassignResult = await reassignOrderToNewRider(activeOrder.id, riderId);
        if (activeOrder.customerPhone) {
          const customerMsg = reassignResult
            ? `⚠️ Aapke rider ko raaste mein masla pesh aaya, doosre riders ko order (#${activeOrder.orderNumber || "N/A"}) foran notify kar diya gaya hai. Sabr ke liye shukriya! 🙏`
            : `⚠️ Aapke order (#${activeOrder.orderNumber || "N/A"}) ki delivery mein thodi dair ho sakti hai — rider ko masla pesh aaya hai. 🙏`;
          await sendMessage(activeOrder.customerPhone, customerMsg);
        }
      }
    } else {
      for (const activeOrder of activeOrders) {
        if (activeOrder.customerPhone) {
          await sendMessage(
            activeOrder.customerPhone,
            `⚠️ Aapke order (#${activeOrder.orderNumber || "N/A"}) ki delivery mein thodi dair ho sakti hai. Hum masla theek kar rahe hain. Shukriya! 🙏`
          );
        }
      }
    }

    return issueResult.urgent
      ? `🚨 Aapki emergency report mil gayi hai${activeOrders.length ? ` (${activeOrders.length} pending order${activeOrders.length === 1 ? "" : "s"} ke sath)` : ""}, staff ko foran alert kar diya gaya hai aur pending orders doosre riders ko notify kar diye gaye hain. Madad jald pahunchegi.`
      : "⚠️ Aapki report dashboard par bhej di gayi hai. Shukriya batane ke liye.";
  } catch {
    return "Kuch technical masla ho gaya. Thodi dair baad try karein.";
  }
}

// ============================================
// COMPLAINTS & ISSUES
// ============================================
const COMPLAINT_KEYWORDS = ["complaint", "complain", "shikayat", "shikayet", "masla", "problem", "kharab", "ghalat", "late", "dair", "mushkil", "issue", "bura"];
const URGENT_RIDER_ISSUE_KEYWORDS = ["accident", "hadsa", "hadsha", "chot", "zakhmi", "girne", "gir gaya", "takra"];
const RIDER_ISSUE_KEYWORDS = ["petrol", "tyre", "tire", "puncher", "puncture", "panchar", "kharab", "breakdown", "band ho gayi", "phas gaya", "phas gayi", ...URGENT_RIDER_ISSUE_KEYWORDS];
const COMPLAINT_STATUS_KEYWORDS = ["status", "meri complaint", "meri shikayat", "shikayat ka status", "complaint status"];

function isComplaintMessage(lowerText) {
  return COMPLAINT_KEYWORDS.some((k) => lowerText.includes(k));
}

function isUrgentRiderIssue(lowerText) {
  return URGENT_RIDER_ISSUE_KEYWORDS.some((k) => lowerText.includes(k));
}

function isComplaintStatusQuery(lowerText) {
  return COMPLAINT_STATUS_KEYWORDS.some((k) => lowerText.includes(k));
}

async function getMostRecentOrderForCustomer(customerPhone) {
  try {
    const snap = await firestoreOperation(() =>
      db.collection("orders")
        .where("customerPhone", "==", customerPhone)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get()
    );
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
  } catch {
    return null;
  }
}

async function getMostRecentComplaint(customerPhone) {
  try {
    const snap = await firestoreOperation(() =>
      db.collection("complaints")
        .where("customerPhone", "==", customerPhone)
        .orderBy("createdAt", "desc")
        .limit(1)
        .get()
    );
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
  } catch {
    return null;
  }
}

function complaintStatusText(complaint) {
  if (!complaint) return "Aapki koi complaint record mein nahi hai.";
  if (complaint.status === "resolved") {
    return `✅ Aapki complaint (${complaint.createdAtReadable || ""}) *hal ho chuki hai*.${complaint.resolutionNote ? `\nTafseel: ${complaint.resolutionNote}` : ""}`;
  }
  return `⏳ Aapki complaint (${complaint.createdAtReadable || ""}) abhi *zair-e-ghor* hai. Hamari team jald rabta karegi.`;
}

async function fileComplaint(customerPhone, complaintText) {
  try {
    const recentOrder = await getMostRecentOrderForCustomer(customerPhone);
    const now = new Date();
    const complaintData = {
      customerPhone,
      complaintText,
      status: "open",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtReadable: formatOrderTime(now),
      relatedOrderId: recentOrder ? recentOrder.id : null,
      relatedOrderNumber: recentOrder ? recentOrder.orderNumber || null : null,
      relatedOrderAddress: recentOrder ? recentOrder.address || null : null,
      relatedOrderTotal: recentOrder ? recentOrder.total || null : null,
      relatedOrderStatus: recentOrder ? recentOrder.status || null : null,
    };
    await firestoreOperation(() => db.collection("complaints").add(complaintData));

    if (STAFF_NUMBER) {
      const orderInfoLines = recentOrder
        ? `\nOrder #${recentOrder.orderNumber || "N/A"}\nAddress: ${recentOrder.address || "N/A"}\nAmount: Rs. ${recentOrder.total || "N/A"}\n`
        : "";
      await sendMessage(
        STAFF_NUMBER,
        `📝 *Nayi Customer Complaint*\n\nCustomer: ${formatPhoneForMsg(customerPhone)}\nMessage: "${complaintText}"\n` +
          orderInfoLines +
          `\n⚠️ Customer se rabta karein.\n(Hal hone par reply karein: *resolved ${formatPhoneForMsg(customerPhone)} <optional note>*)`
      );
    }
    return recentOrder;
  } catch {
    return null;
  }
}

// Staff marks a customer's most recent open complaint resolved, and the customer is
// automatically informed — closing the loop instead of leaving them wondering.
async function resolveComplaintForCustomer(rawPhone, note) {
  const customerPhone = normalizePhoneForLookup(rawPhone);
  try {
    const snap = await firestoreOperation(() =>
      db.collection("complaints")
        .where("customerPhone", "==", customerPhone)
        .where("status", "==", "open")
        .orderBy("createdAt", "desc")
        .limit(1)
        .get()
    );
    if (snap.empty) {
      return { staffMsg: `Is number (${formatPhoneForMsg(customerPhone)}) ki koi open complaint nahi mili.` };
    }
    const doc = snap.docs[0];
    await firestoreOperation(() =>
      doc.ref.update({
        status: "resolved",
        resolutionNote: note || null,
        resolvedAt: admin.firestore.FieldValue.serverTimestamp()
      })
    );
    await sendMessage(
      customerPhone,
      `✅ Aapki complaint ka masla *hal ho gaya hai*.${note ? `\nTafseel: ${note}` : ""}\nShukriya sabr karne ke liye! 🙏`
    );
    return { staffMsg: `✅ Complaint resolved aur customer ko inform kar diya gaya hai.` };
  } catch {
    return { staffMsg: "Resolve karte waqt masla aaya, dobara try karein." };
  }
}

async function fileRiderIssue(riderId, riderData, issueText, activeOrders) {
  try {
    const now = new Date();
    const urgent = isUrgentRiderIssue(issueText.toLowerCase());
    const relatedOrders = (activeOrders || []).map(o => ({
      orderId: o.id,
      orderNumber: o.orderNumber || null,
      customerPhone: o.customerPhone || null,
      customerName: o.customerName || null,
      address: o.address || null,
    }));

    const issueData = {
      riderPhone: riderId,
      riderName: riderData.name || null,
      issueText,
      urgent,
      status: "open",
      relatedOrders,
      lat: typeof riderData.lat === "number" ? riderData.lat : null,
      lng: typeof riderData.lng === "number" ? riderData.lng : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdAtReadable: formatOrderTime(now),
    };
    await firestoreOperation(() => db.collection("riderIssues").add(issueData));

    const orderInfoLines = relatedOrders.length
      ? "\n" + relatedOrders.map(o =>
          `Order #${o.orderNumber || "N/A"}${o.customerName ? ` — ${o.customerName}` : ""}${o.customerPhone ? ` (${formatPhoneForMsg(o.customerPhone)})` : ""}${o.address ? `\n  Address: ${o.address}` : ""}`
        ).join("\n") + "\n"
      : "\n(Is rider ke pass koi pending order darj nahi tha.)\n";

    if (urgent && STAFF_NUMBER) {
      const riderPhoneDisplay = formatPhoneForMsg(riderId);
      let alertMsg =
        `🚨 *EMERGENCY — Rider Accident/Injury Report*\n\n` +
        `Rider: *${riderData.name || "N/A"}*\n` +
        `Number: ${riderPhoneDisplay}\n` +
        `Message: "${issueText}"\n` +
        `Pending Orders:${orderInfoLines}`;
      if (isRiderLocationFresh(riderData)) {
        alertMsg += `\nLast Known Location: ${mapsLink(riderData.lat, riderData.lng)}`;
      }
      alertMsg += `\n\n⚠️ Foran contact karein!`;
      await sendMessage(STAFF_NUMBER, alertMsg);
    } else if (STAFF_NUMBER) {
      const riderPhoneDisplay = formatPhoneForMsg(riderId);
      await sendMessage(
        STAFF_NUMBER,
        `⚠️ *Rider Issue Report*\n\nRider: *${riderData.name || "N/A"}*\nNumber: ${riderPhoneDisplay}\nMessage: "${issueText}"\nPending Orders:${orderInfoLines}`
      );
    }
    return { urgent };
  } catch {
    return { urgent: false };
  }
}

// ============================================
// ANALYTICS
// ============================================
async function updateAnalytics() {
  try {
    const today = new Date().toDateString();
    const orders = await db.collection("orders")
      .where("createdAt", ">=", new Date(today))
      .get();

    let totalOrders = 0, totalRevenue = 0, deliveredCount = 0, totalTime = 0;

    orders.forEach(doc => {
      const order = doc.data();
      totalOrders++;
      totalRevenue += order.total || 0;
      if (order.status === "delivered" && order.deliveredAt) {
        const time = order.deliveredAt.toDate() - order.createdAt.toDate();
        totalTime += time;
        deliveredCount++;
      }
    });

    await db.collection("analytics").doc(today).set({
      date: today,
      totalOrders,
      totalRevenue,
      avgDeliveryTime: deliveredCount > 0 ? Math.round(totalTime / deliveredCount / 60000) : 0,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch {}
}

async function notifyDashboard(data) {
  if (!DASHBOARD_WEBHOOK) return;
  try {
    await axios.post(DASHBOARD_WEBHOOK, data, { timeout: 3000 });
  } catch {}
}

// ============================================
// WHATSAPP SENDER
// ============================================
async function sendMessage(to, body) {
  try {
    await axios.post(
      `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      { messaging_product: "whatsapp", to, text: { body } },
      {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        timeout: 10000,
      }
    );
  } catch (err) {
    console.error("Send message failed:", err.response?.data || err.message);
  }
}

// ============================================
// DINE-IN
// ============================================
async function notifyStaffDineIn(tableNumber, customerName, cart) {
  try {
    const msg =
      `🍽️ *Naya Dine-In Order — Table ${tableNumber}*\n` +
      `👤 Customer: ${customerName}\n` +
      `💰 Payment: Mil gayi ✅\n\n` +
      `${cartText(cart)}\n\n` +
      `Kitchen ko bata dein taake taiyari shuru ho.`;
    if (STAFF_NUMBER) await sendMessage(STAFF_NUMBER, msg);
  } catch {}
}

// ============================================
// WEBHOOK
// ============================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    const messageId = message.id;
    if (processedMessages.has(messageId)) return res.sendStatus(200);
    processedMessages.add(messageId);
    setTimeout(() => processedMessages.delete(messageId), 60 * 60 * 1000);

    const from = message.from;
    const text = (message.text?.body || "").trim();
    const lower = text.toLowerCase();

    // Staff commands (e.g. resolving a complaint) — handled before anything else so
    // staff messages never accidentally fall into the customer ordering flow.
    if (STAFF_NUMBER && from === STAFF_NUMBER && message.type === "text") {
      const resolveMatch = text.match(/^resolved\s+(\S+)(?:\s+([\s\S]*))?$/i);
      if (resolveMatch) {
        const result = await resolveComplaintForCustomer(resolveMatch[1], resolveMatch[2]);
        await sendMessage(STAFF_NUMBER, result.staffMsg);
        return res.sendStatus(200);
      }
    }

    // Check if Rider
    let riderDoc;
    try {
      riderDoc = await firestoreOperation(() =>
        db.collection("riders").doc(from).get()
      );
    } catch {
      return res.sendStatus(200);
    }

    if (riderDoc.exists) {
      if (message.type === "location") {
        const { latitude, longitude } = message.location;
        await firestoreOperation(() =>
          db.collection("riders").doc(from).update({
            lat: latitude,
            lng: longitude,
            locationUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
          })
        );
        const riderData = riderDoc.data();
        await notifyCustomerOfRiderLocation(from, { ...riderData, lat: latitude, lng: longitude });
        await sendMessage(from, "📍 Aapki location update ho gayi hai. Shukriya!");
        return res.sendStatus(200);
      }

      // Rider sending a photo as delivery proof for a SPECIFIC order — since a
      // rider can have several active orders now, they must say which one:
      // send the photo with caption "3/<orderNumber>". A bare photo with no
      // caption is rejected with instructions instead of guessing.
      if (message.type === "image") {
        const caption = (message.image?.caption || "").trim();
        const capMatch = caption.match(/^3\s*\/\s*(\d+(?:_\d+)?)$/);
        if (capMatch) {
          const riderData = riderDoc.data();
          const reply = await handleStatusCommand(from, riderData, "3", capMatch[1]);
          await sendMessage(from, reply);
        } else {
          await sendMessage(from, "📸 Photo mili, lekin pata nahi kaunsa order — photo ke caption mein *3/<order number>* likh kar dobara bhejein.");
        }
        return res.sendStatus(200);
      }

      const reply = await handleRiderReply(from, text.trim());
      if (reply) await sendMessage(from, reply);
      return res.sendStatus(200);
    }

    // Customer location
    if (message.type === "location") {
      const { latitude, longitude } = message.location;
      const forwarded = await forwardLocationToRider(from, latitude, longitude);
      await sendMessage(from, forwarded
        ? "📍 Aapki location rider ko bhej di gayi hai. Shukriya!"
        : "📍 Location mil gayi, lekin filhal koi active order nahi mila."
      );
      return res.sendStatus(200);
    }

    // Delivery confirmation
    if (message.type === "text") {
      const isYes = ["yes", "y", "haan", "han"].includes(lower) || lower.includes("mil gaya") || lower.includes("mil gya");
      const isNo = ["no", "n", "nahi", "nai"].includes(lower) || lower.includes("nahi mila");

      if (isYes || isNo) {
        try {
          const pendingSnap = await firestoreOperation(() =>
            db.collection("orders")
              .where("customerPhone", "==", from)
              .where("status", "==", "delivered_pending_confirmation")
              .limit(1)
              .get()
          );
          if (!pendingSnap.empty) {
            const pendingDoc = pendingSnap.docs[0];
            const order = pendingDoc.data();
            if (isYes) {
              await firestoreOperation(() =>
                pendingDoc.ref.update({
                  status: "delivered",
                  confirmedAt: admin.firestore.FieldValue.serverTimestamp()
                })
              );
              await sendMessage(from, "🙏 Shukriya! Khaane ka mazaa lein. Karachi Noor Biryani & Murgh Pulao choose karne ke liye shukriya!");
              updateAnalytics();
            } else {
              await firestoreOperation(() =>
                pendingDoc.ref.update({
                  status: "delivery_issue_reported",
                  issueReportedAt: admin.firestore.FieldValue.serverTimestamp()
                })
              );
              await sendMessage(from, "😟 Maazrat chahenge! Hum foran is masle ko dekh rahe hain, hamari team jald aap se rabta karegi.");
              if (STAFF_NUMBER) {
                await sendMessage(
                  STAFF_NUMBER,
                  `🚨 *Delivery Issue Reported*\n\nOrder #${order.orderNumber || "N/A"}\nCustomer: ${formatPhoneForMsg(from)}\nAddress: ${order.address || "N/A"}\nRider: ${order.riderName || "N/A"}\n\n⚠️ Foran check karein!`
                );
              }
            }
            return res.sendStatus(200);
          }
        } catch {}
      }
    }

    // Main customer flow
    const session = await getSession(from);

    // If we're in the middle of collecting complaint details, that takes priority
    // over every other keyword — this is what makes the two-step complaint flow work.
    if (session.stage === "awaiting_complaint" && message.type === "text") {
      const recentOrder = await fileComplaint(from, text);
      session.stage = session.resumeStage || "menu";
      delete session.resumeStage;
      await saveSession(from, session);
      await sendMessage(from, recentOrder
        ? `📝 Aapki shikayat darj ho gayi hai (Order #${recentOrder.orderNumber || "N/A"}). Hamari team jald rabta karegi. Shukriya!`
        : `📝 Aapki shikayat darj ho gayi hai. Hamari team jald rabta karegi. Shukriya!`
      );
      return res.sendStatus(200);
    }

    // Complaint status check — lets a returning customer ask "status" and get remembered.
    if (message.type === "text" && isComplaintStatusQuery(lower)) {
      const complaint = await getMostRecentComplaint(from);
      await sendMessage(from, complaintStatusText(complaint));
      return res.sendStatus(200);
    }

    // Track order
    if (["track", "kahan", "kaha", "kidhar", "location"].some(k => lower.includes(k))) {
      const reply = await getRiderLocationReply(from);
      await sendMessage(from, reply);
      return res.sendStatus(200);
    }

    // Complaint — first ask the customer to actually describe the problem, THEN file it.
    const PENDING_ORDER_STAGES = ["address", "payment", "waiting_payment", "dinein_name", "dinein_payment"];

    if (message.type === "text" && lower === "cancel" && PENDING_ORDER_STAGES.includes(session.stage)) {
      session.cart = [];
      session.address = "";
      session.customerName = "";
      session.isDineIn = false;
      session.tableNumber = null;
      session.stage = "menu";
      await saveSession(from, session);
      await sendMessage(from, "❌ Aapka pending order cancel kar diya gaya hai. Naya order shuru karne ke liye *menu* likhein.");
      return res.sendStatus(200);
    }

    const STAGES_TO_SKIP_COMPLAINT = ["address", "dinein_name", "waiting_payment", "dinein_payment"];
    if (message.type === "text" && isComplaintMessage(lower) && !STAGES_TO_SKIP_COMPLAINT.includes(session.stage)) {
      session.resumeStage = session.stage;
      session.stage = "awaiting_complaint";
      await saveSession(from, session);
      await sendMessage(from, "😟 Maazrat! Please apni complaint ki tafseel likh kar bhejein taake hum sahi tarah madad kar sakein.");
      return res.sendStatus(200);
    }

    // Menu/Order flow
    let reply = "";
    const tableMatch = text.match(/^order\s*-\s*table\s*(\d+)/i);

    if (
      PENDING_ORDER_STAGES.includes(session.stage) &&
      (["menu", "hi", "hello", "salam"].includes(lower) ||
        /\b(rate|rates|price|prices|qeemat|qeematen|rate list|price list)\b/.test(lower) ||
        /^order\s*-\s*table\s*\d+/i.test(text))
    ) {
      reply = `⏳ Aapka pehle se ek order pending hai (payment/confirmation ka intezar). Pehle wo mukammal karein, ya *cancel* likh kar cancel karein aur naya order shuru karein.`;
    } else if (tableMatch && session.stage === "menu") {
      session.isDineIn = true;
      session.tableNumber = tableMatch[1];
      session.stage = "ordering";
      reply = `🍽️ *Table ${session.tableNumber}* — Khush aamdeed!\n\n${menuText()}`;
    } else if (
      session.stage === "menu" ||
      ["menu", "hi", "hello", "salam"].includes(lower) ||
      /\b(rate|rates|price|prices|qeemat|qeematen|rate list|price list)\b/.test(lower)
    ) {
      const isFirstGreeting = session.stage === "menu" && session.cart.length === 0 && !session.customerName;
      if (isFirstGreeting) {
        const profile = await getCustomerProfile(from);
        if (profile && profile.name) {
          reply = `Wapis khush aamdeed, ${profile.name}! 🙏\n\n${menuText()}`;
        } else {
          reply = menuText();
        }
      } else {
        reply = menuText();
      }
      session.stage = "ordering";
    } else if (session.stage === "ordering" && /^\d+x\d+$/.test(lower)) {
      const [itemId, qty] = lower.split("x").map(Number);
      const item = MENU.find(m => m.id === itemId);
      if (item) {
        const existing = session.cart.find(c => c.id === itemId);
        if (qty === 0) {
          session.cart = session.cart.filter(c => c.id !== itemId);
          reply = `🗑️ ${item.name} cart se hata diya.\n\n${cartText(session.cart)}`;
        } else if (existing) {
          existing.qty = qty;
          reply = `✅ ${item.name} ki quantity update: x${qty}.\n\n${cartText(session.cart)}`;
        } else {
          session.cart.push({ id: item.id, name: item.name, price: item.price, qty });
          reply = `✅ ${item.name} x${qty} cart mein add.\n\n${cartText(session.cart)}`;
        }
      } else {
        reply = "Yeh item number valid nahi hai. *menu* likhein.";
      }
    } else if (session.stage === "ordering" && /^remove\s*\d+$/.test(lower)) {
      const itemId = parseInt(lower.replace(/\D/g, ""), 10);
      const item = MENU.find(m => m.id === itemId);
      const existed = session.cart.some(c => c.id === itemId);
      session.cart = session.cart.filter(c => c.id !== itemId);
      reply = existed
        ? `🗑️ ${item ? item.name : "Item"} cart se hata.\n\n${cartText(session.cart)}`
        : `Yeh item cart mein tha hi nahi.\n\n${cartText(session.cart)}`;
    } else if (session.stage === "ordering" && lower === "cart") {
      reply = `${cartText(session.cart)}\n\nAur item add karen (jaise *1x2*), ya *done* likh kar order confirm karen.`;
    } else if (["dinein_name", "dinein_payment", "address", "waiting_payment"].includes(session.stage) && lower === "edit") {
      session.stage = "ordering";
      reply = `${cartText(session.cart)}\n\nOrder edit kar rahe hain. *done* likh kar confirm karen.`;
    } else if (session.stage === "ordering" && lower === "done") {
      if (session.cart.length === 0) {
        reply = "Aapne abhi tak kuch order nahi kiya. Item number likhein, jaise *1x2*.";
      } else if (session.isDineIn) {
        session.stage = "dinein_name";
        reply = `${cartText(session.cart)}\n\nOrder confirm karne ke liye apna *naam* likh dein.`;
      } else {
        session.stage = "address";
        const profile = await getCustomerProfile(from);
        reply = `${cartText(session.cart)}\n\nAb apna delivery address likh dein.`;
        if (profile && profile.lastAddress) {
          reply += `\n\n(Pichli dafa aapne yeh address diya tha: "${profile.lastAddress}" — agar wahi hai to ye dobara likh dein, ya naya address bhej dein.)`;
        }
      }
    } else if (session.stage === "dinein_name") {
      session.customerName = text;
      session.stage = "dinein_payment";
      const total = cartTotal(session.cart);
      reply =
        `Shukriya ${session.customerName}! 🙏\n\n` +
        `💳 *Payment Details:*\nJazzCash: ${PAYMENT_INFO.jazzcash}\nEasypaisa: ${PAYMENT_INFO.easypaisa}\nAccount Title: ${PAYMENT_INFO.accountTitle}\n\n` +
        `Total Amount: *Rs. ${total}*\n\n` +
        `Payment karne ke baad screenshot bhej dein — order kitchen ko Table ${session.tableNumber} ke naam bhej diya jayega.`;
    } else if (session.stage === "dinein_payment") {
      if (message.type === "image") {
        // NOTE: still accepts any image as "proof" — see payment-verification
        // caveat below. A staff member should glance at the dashboard before
        // the kitchen actually starts cooking if that risk matters to you.
        await notifyStaffDineIn(session.tableNumber, session.customerName, session.cart);
        reply = `✅ *Payment Accepted!* ${session.customerName}, aapka order kitchen ko bhej diya gaya hai — *Table ${session.tableNumber}*. Shukriya! 🍛`;
        await saveCustomerProfile(from, { name: session.customerName || null });
        await clearSession(from);
      } else {
        reply = "Hum aapki payment screenshot ka intezaar kar rahe hain. Bhej dein.";
      }
    } else if (session.stage === "address") {
      session.address = text;
      session.stage = "payment";
      const total = cartTotal(session.cart);
      reply =
        `📍 Address: ${session.address}\n\n` +
        `💳 *Payment Details:*\nJazzCash: ${PAYMENT_INFO.jazzcash}\nEasypaisa: ${PAYMENT_INFO.easypaisa}\nAccount Title: ${PAYMENT_INFO.accountTitle}\n\n` +
        `Total Amount: *Rs. ${total}*\n\n` +
        `Payment screenshot bhej dein. Order confirm hote hi riders ko notify kar diya jayega. 🙏`;
      session.stage = "waiting_payment";
    } else if (session.stage === "waiting_payment") {
      if (message.type === "image") {
        // NOTE: still accepts any image as "proof" — see payment-verification
        // caveat below.
        reply = await createOrderAndBroadcast(from, session);
        await clearSession(from);
      } else {
        reply = "Hum aapki payment screenshot ka intezaar kar rahe hain. Bhej dein.";
      }
    } else {
      try {
        reply = await getHaikuReply(text, session.aiHistory);
        session.aiHistory.push({ role: "user", content: text });
        session.aiHistory.push({ role: "assistant", content: reply });
        if (session.aiHistory.length > 20) session.aiHistory = session.aiHistory.slice(-20);
      } catch {
        reply = "Maazrat, mujhe samajh nahi aaya. *menu* likhein.";
      }
    }

    if (sessions[from]) await saveSession(from, sessions[from]);
    await sendMessage(from, reply);
    res.sendStatus(200);
  } catch (err) {
    console.error("Error:", err.message);
    res.sendStatus(200);
  }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get("/health", async (req, res) => {
  const status = {
    whatsapp: false,
    firebase: false,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  };
  try {
    await firestoreOperation(() => db.collection("meta").doc("health").get());
    status.firebase = true;
  } catch {}
  try {
    await axios.get(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}`, {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      timeout: 5000
    });
    status.whatsapp = true;
  } catch {}
  res.status(status.whatsapp && status.firebase ? 200 : 503).json(status);
});

app.get("/", (req, res) => {
  res.send("Karachi Noor Biryani & Murgh Pulao Bot ✅ | Dashboard Connected");
});

// ============================================
// START
// ============================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`📊 Dashboard connected via Firestore`);
  console.log(`👥 Riders: broadcast-and-claim model active`);
  console.log(`⭐ Loyalty points: active`);
  console.log(`📈 Analytics: auto-updating`);
});
