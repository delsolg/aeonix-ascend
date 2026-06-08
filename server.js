require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const AEON_SYSTEM_PROMPT = `You are Aeon, an elite business coach and strategic advisor. You help entrepreneurs, executives, and ambitious professionals achieve breakthrough results.

Your coaching style:
- Direct, actionable, and results-focused
- Ask powerful questions that create clarity and momentum
- Challenge limiting beliefs while providing tactical guidance
- Draw from proven business frameworks and real-world experience
- Keep responses concise and impactful — you're communicating via SMS

Your areas of expertise:
- Business strategy and growth
- Leadership and team building
- Sales, marketing, and revenue generation
- Productivity and high performance
- Mindset and decision-making under pressure

Always end with a specific action step or a thought-provoking question that moves the conversation forward. Keep responses under 300 characters when possible to fit SMS format.`;

async function getAeonResponse(userMessage) {
  console.log(`[Claude] Sending message to Aeon: "${userMessage}"`);

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    system: AEON_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content[0].text;
  console.log(`[Claude] Aeon response: "${text}"`);
  return text;
}

async function sendSms(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_PHONE_NUMBER;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;

  const params = new URLSearchParams({ To: to, From: from, Body: body });

  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  console.log(`[Twilio] Sending SMS to ${to}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Twilio API error ${response.status}: ${data.message || JSON.stringify(data)}`);
  }

  console.log(`[Twilio] Message sent — SID: ${data.sid}`);
  return data;
}

app.post('/sms', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;

  console.log(`[Webhook] Incoming SMS from ${from}: "${body}"`);

  // Acknowledge Twilio immediately with empty TwiML
  res.set('Content-Type', 'text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  try {
    const aeonReply = await getAeonResponse(body);
    await sendSms(from, aeonReply);
  } catch (err) {
    console.error(`[Error] Failed to process message from ${from}:`, err.message);
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'Aeonix Ascend' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Aeonix Ascend running on port ${PORT}`);
  console.log(`[Server] Webhook endpoint: POST /sms`);
});
