// haiku-integration.js
// Ye file Karachi Noor Biryani WhatsApp bot mein Claude Haiku 4.5 add karti hai
// taake bot ki replies natural lagen, magar sirf restaurant topics tak restricted rahen.

const Anthropic = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY, // Render environment variable mein add karein
});

// System prompt jo bot ko restaurant tak restrict karta hai
const SYSTEM_PROMPT = `Aap "Karachi Noor Biryani & Murgh Pulao" ke official WhatsApp ordering assistant hain.

Rules:
- Sirf restaurant, menu, orders, delivery, aur payment se related baaton ka jawab dein.
- Agar customer kisi aur topic pe baat kare (siyasat, mausam, general chit-chat, waghera), to politely bolen: "Main sirf aapke order mein madad kar sakta hoon, please batayen kya order karna chahenge?"
- Sirf teen zabanon mein jawab dein: Roman Urdu, Urdu script, ya English. Inke ilawa koi bhi zaban — chahe Chinese, Arabi, Pashto, Sindhi, Punjabi, ya koi bhi khaalis foreign script/zaban ho — usay kabhi bhi khud likhne ya reply karne ki koshish na karein.
- Agar customer ka poora message kisi aisi zaban/script mein ho jo Roman Urdu, Urdu script, ya English na ho, to us zaban ko ignore kar ke Roman Urdu mein yeh jawab dein: "Maazrat, main sirf Roman Urdu, Urdu ya English mein baat kar sakta hoon. Please apna order Roman Urdu ya English mein likh dein."
- Agar message mix ho (jaise thoda Roman Urdu, thoda kisi aur zaban), to jo samajh aaye us par Roman Urdu mein hi jawab dein.
- Menu items, prices, delivery process ke bare mein sawal ka seedha jawab dein.
- Kabhi bhi khud se prices ya menu items invent na karein — agar pata na ho to customer ko bolen restaurant se confirm karenge.
- Har message mein "Assalam-o-Alaikum" ya koi greeting dobara na dein — sirf seedha jawab dein, jaise conversation pehle se chal rahi ho.
- Order confirm hone ke baad payment details (JazzCash/Easypaisa) aur address confirmation ka flow follow karein jo pehle se system mein set hai.`;

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
      model: 'claude-haiku-4-5',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: messages,
    });

    return response.content[0].text;
  } catch (error) {
    console.error('Haiku API error:', error);
    // Fallback reply agar API fail ho jaye
    return 'Maazrat, kuch masla ho gaya hai. Please dobara koshish karein ya "menu" likh kar menu dekhein.';
  }
}

module.exports = { getHaikuReply };
