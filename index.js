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
    const riderDisplayName = assignedRider.name || "Rider";

    await orderRef.update({
      status: "assigned",
      riderPhone: assignedRider.id,
      riderName: riderDisplayName,
    });

    const riderMsg =
      `🛵 *Naya Order Assign Hua*\n\n` +
      `${cartText(session.cart)}\n\n` +
      `Address: ${session.address}\n` +
      `Customer Number: ${customerPhone}\n\n` +
      `Jab order pick kar lein to reply karein: *1*\n` +
      `Jab deliver ho jaye to reply karein: *2*`;
    await sendMessage(assignedRider.id, riderMsg);

    return `✅ Payment screenshot mil gayi hai. Aapka order confirm ho gaya hai — *${riderDisplayName}* aapki delivery ke liye assign ho gaye hain. Jald hi pahunch jayega! 🍛`;
  } else {
    return `✅ Payment screenshot mil gayi hai. Order confirm ho gaya hai — filhal hamare riders busy hain, jaise hi koi free hota hai order assign kar diya jayega. Shukriya! 🙏`;
  }
}
