# Bot Setup - Aasan Steps

## Yeh code kya karta hai
- Customer WhatsApp pe "hi" ya "menu" likhta hai -> bot menu bhejta hai
- Customer "1x2" jaisa likh kar order karta hai (item number x quantity)
- "done" likhne pe cart dikhata hai aur address maangta hai
- Address dene ke baad JazzCash/Easypaisa number bhejta hai
- Payment screenshot bhejne pe order confirm ho jata hai

## Menu Change Karna
`index.js` file mein `MENU` wala hissa dhoondein, apni items aur prices daal den.

## Payment Numbers Change Karna
`index.js` mein `PAYMENT_INFO` wala hissa dhoondein, apna JazzCash/Easypaisa number daal den.

## GitHub Par Upload Karna
1. Repository khol len (karachi-noor-biryani-and-murgh-pulao)
2. "Add file" > "Upload files" pe click karen
3. Yeh teeno files (index.js, package.json, SETUP_URDU.md) drag karke daal den
4. Neeche "Commit changes" pe click karen

## Render.com Par Deploy Karna
1. render.com pe GitHub se login karen
2. "New +" > "Web Service" select karen
3. Apni repository (karachi-noor-biryani-and-murgh-pulao) select karen
4. Yeh settings bharen:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. "Environment Variables" mein yeh 3 cheezein add karen:
   - VERIFY_TOKEN = ummatfoods123 (ya koi bhi apna word)
   - WHATSAPP_TOKEN = (Meta se mila access token)
   - PHONE_NUMBER_ID = (Meta se mila phone number id)
6. "Create Web Service" pe click karen

Deploy hone ke baad ek URL milega jaise: `https://restaurant-bot-xxxx.onrender.com`

## Meta Se Connect Karna
1. Meta App > WhatsApp > Configuration mein jayen
2. Webhook URL mein daalen: `https://restaurant-bot-xxxx.onrender.com/webhook`
3. Verify Token mein wahi likhen jo Render mein VERIFY_TOKEN rakha tha
4. "Verify and Save" pe click karen
5. "messages" field ko subscribe karen
