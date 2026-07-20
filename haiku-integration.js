// haiku-integration.js
// Ye file Karachi Noor Biryani WhatsApp bot mein Claude Haiku 4.5 add karti hai
// taake bot ki replies natural lagen, magar sirf restaurant topics tak restricted rahen.
//
// FIXED:
// 1. Model name galat tha ("claude-haiku-4-5") — is wajah se HAR API call fail ho rahi thi
//    aur bot hamesha "Maazrat, kuch masla ho gaya hai..." wala fallback bhej raha tha.
//    Sahi model string: "claude-haiku-4-5-20251001"
// 2. AI ko asal MENU/rates nahi diye gaye the, is liye "Rate list" jaise sawal par
//    AI khud se items/prices bana raha tha (hallucination). Ab system prompt mein
//    real menu seedha inject kiya gaya hai taake AI hamesha sahi rates bataye.

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY, // Render environment variable mein add karein
});

// FIXED: sahi model name
const MODEL_NAME = 'claude-haiku-4-5-20251001';

// Real menu — index.js wale MENU se match hona chahiye. Agar index.js mein menu
// update karein, to yahan bhi update karein taake AI ke jawab hamesha sahi rahen.
const MENU_FOR_AI = `
1. Chicken Biryani - Rs. 350
2. Mutton Pulao - Rs. 500
3. Chicken Karahi (Full) - Rs. 1200
4. Chicken Karahi (Half) - Rs. 650
5. Seekh Kabab (4 pcs) - Rs. 300
6. Raita - Rs. 60
7. Salad - Rs. 50
8. Cold Drink (500ml) - Rs. 80
`.trim();

// System prompt jo bot ko restaurant tak restrict karta hai
function buildSystemPrompt() {
  return `Aap "Karachi Noor Biryani & Murgh Pulao" ke official WhatsApp ordering assistant hain.

Yeh hamara ASAL menu aur rates hain — hamesha inhi ka hawala dein, kabhi bhi koi aur item ya rate na banayen:
${MENU_FOR_AI}

Rules:
- Sirf restaurant, menu, orders, delivery, aur payment se related baaton ka jawab dein.
- Agar customer menu, rates, prices, ya kisi item ke baare mein poochay, to hamesha upar diye gaye ASAL menu mein se hi jawab dein — koi naya item ya rate kabhi na banayen.
- Agar poocha gaya item upar ke menu mein maujood nahi hai, to seedha bolen ke yeh item menu mein available nahi hai, aur maujooda menu items bata dein.
- Agar customer kisi aur topic pe baat kare (siyasat, mausam, general chit-chat, waghera), to politely bolen: "Main sirf aapke order mein madad kar sakta hoon, please batayen kya order karna chahenge?"
- Customer jis bhi zaban ya script mein message likhe — Roman Urdu, Urdu script, English, Pashto (Roman ya Pashto script), Sindhi, Punjabi, Arabi, Chinese, ya duniya ki koi bhi zaban — usi zaban mein jawab dene ki poori koshish karein. Kabhi na bolen ke aap sirf mahdood zabanon mein jawab de sakte hain.
- Agar customer ka message mix ho (jaise thoda Roman Urdu, thoda kisi aur zaban), to jis zaban mein zyada baat ki gayi ho usi mein jawab dein.
- Agar kisi zaban mein aapko poora yaqeen na ho ke sahi likh rahe hain, to phir bhi poori koshish karein aur maazrat na karein baar baar — seedha madad karein.
- Har message mein "Assalam-o-Alaikum" ya koi greeting dobara na dein — sirf seedha jawab dein, jaise conversation pehle se chal rahi ho.
- Pichli baatcheet (conversation history) ko dhyan mein rakhen aur usi context ke mutabiq jawab dein — customer ko dobara wahi sawal na karein jo pehle pooch chuke hain.
- Order confirm hone ke baad payment details (JazzCash/Easypaisa) aur address confirmation ka flow follow karein jo pehle se system mein set hai.`;
}

/**
 * Haiku se natural reply generate karta hai
 * @param {string} userMessage - Customer ka WhatsApp message
 * @param {Array} conversationHistory - Pichle messages [{role: 'user'|'assistant', content: '...'}]
 * @returns {Promise<string>} - Bot ka reply
 */
async function getHaikuReply(userMessage, conversationHistory = []) {
  try {
    const messages = [
      ...conversationHistory,
      { role: 'user', content: userMessage }
    ];

    const response = await anthropic.messages.create({
      model: MODEL_NAME,
      max_tokens: 300,
      system: buildSystemPrompt(),
      messages: messages,
    });

    return response.content[0].text;
  } catch (error) {
    console.error('Haiku API error:', error.status || '', error.message);
    // Fallback reply agar API fail ho jaye
    return 'Maazrat, kuch masla ho gaya hai. Please dobara koshish karein ya "menu" likh kar menu dekhein.';
  }
}

/**
 * Payment screenshot ko "parh" kar amount, account number, aur date/time nikalta hai
 * @param {string} base64Image - Image ka base64 data
 * @param {string} mimeType - jaise 'image/jpeg' ya 'image/png'
 * @returns {Promise<Object>} - { isPaymentScreenshot, amount, accountNumber, dateTime }
 */
async function verifyPaymentScreenshot(base64Image, mimeType) {
  const VERIFY_PROMPT = `Aap ek JazzCash/Easypaisa payment screenshot verifier hain. Aapko ek image di jayegi.

Is image ko dhyan se dekh kar yeh maloomat nikalein:
- isPaymentScreenshot: true agar yeh koi JazzCash, Easypaisa, ya bank transfer confirmation screenshot hai, warna false (jaise agar khaane ki photo, random image, ya kuch aur hai to false)
- amount: transaction ki amount, sirf number (Rs/PKR ka symbol chhod kar), agar na mile to null
- accountNumber: jis number/account pe paisa bheja gaya hai (receiver), sirf digits, agar na mile to null
- dateTime: transaction ki date aur time jo screenshot mein likhi ho, jaise likhi hai waisi hi string mein, agar na mile to null

Sirf neeche diye JSON format mein jawab dein, koi aur text, explanation, ya markdown fences bilkul na likhein:
{"isPaymentScreenshot": true, "amount": 500, "accountNumber": "03005583968", "dateTime": "19 Jul 2026, 5:32 PM"}`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL_NAME,
      max_tokens: 300,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64Image } },
            { type: 'text', text: VERIFY_PROMPT },
          ],
        },
      ],
    });

    let text = response.content[0].text.trim();
    text = text.replace(/```json|```/g, '').trim();
    return JSON.parse(text);
  } catch (error) {
    console.error('Payment verification error:', error.message);
    return { isPaymentScreenshot: null, amount: null, accountNumber: null, dateTime: null, verifyFailed: true };
  }
}

module.exports = { getHaikuReply, verifyPaymentScreenshot };
