require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Allow the GitHub Pages site (or any origin) to POST to this server
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Serve index.html for direct server deployments
app.use(express.static(path.join(__dirname), { dotfiles: 'deny' }));

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID || 'appPxAUdkGx9NY5a8';
const AIRTABLE_ROOT = `https://api.airtable.com/v0/${AIRTABLE_BASE}`;

// How many prior exchanges to include as context (each exchange = 1 user + 1 assistant turn)
const HISTORY_EXCHANGES = 5;

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePhone(raw) {
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  return `+${digits}`;
}

function airtableFetch(path, options = {}) {
  return fetch(`${AIRTABLE_ROOT}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Airtable — conversation history
//
// Fetches the last HISTORY_EXCHANGES * 2 records for a phone number and
// returns them as a Claude messages array (oldest first).
// ---------------------------------------------------------------------------

async function getConversationHistory(phone) {
  const limit = HISTORY_EXCHANGES * 2;
  const filter = encodeURIComponent(`{Phone}="${phone}"`);
  const qs = `filterByFormula=${filter}&sort[0][field]=Timestamp&sort[0][direction]=desc&maxRecords=${limit}`;

  try {
    const res = await airtableFetch(`/Conversations?${qs}`);
    if (!res.ok) {
      console.warn(`[Airtable] History fetch failed (${res.status}) for ${phone}`);
      return [];
    }
    const data = await res.json();
    const records = (data.records || []).reverse(); // oldest first

    const messages = [];
    for (const r of records) {
      messages.push({ role: 'user',      content: r.fields.Message  || '' });
      messages.push({ role: 'assistant', content: r.fields.Response || '' });
    }
    return messages;
  } catch (err) {
    console.warn(`[Airtable] History error for ${phone}:`, err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Airtable — log conversation
// ---------------------------------------------------------------------------

async function logToAirtable(phone, message, response) {
  const payload = {
    records: [{
      fields: {
        Phone:     phone,
        Message:   message,
        Response:  response,
        Timestamp: new Date().toISOString(),
        UserID:    phone,
      },
    }],
  };

  const res = await airtableFetch('/Conversations', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Airtable Conversations error ${res.status}: ${JSON.stringify(err)}`);
  }

  console.log(`[Airtable] Conversation logged for ${phone}`);
}

// ---------------------------------------------------------------------------
// Airtable — save waitlist user
//
// Requires a "Users" table in your Airtable base with these fields:
//   FirstName    (Single line text)
//   Phone        (Single line text)
//   BusinessType (Single line text)
//   SignupDate   (Single line text)
//   Status       (Single line text)  default: "waitlist"
// ---------------------------------------------------------------------------

async function saveUserToAirtable(firstName, phone, businessType) {
  const payload = {
    records: [{
      fields: {
        FirstName:    firstName,
        Phone:        phone,
        BusinessType: businessType,
        SignupDate:   new Date().toISOString(),
        Status:       'waitlist',
      },
    }],
  };

  const res = await airtableFetch('/Users', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Airtable Users error ${res.status}: ${JSON.stringify(err)}`);
  }

  console.log(`[Airtable] User saved: ${firstName} (${phone})`);
}

// ---------------------------------------------------------------------------
// Twilio — send SMS
// ---------------------------------------------------------------------------

async function sendSms(to, body) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  const from       = process.env.TWILIO_PHONE_NUMBER;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

  console.log(`[Twilio] Sending SMS to ${to}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:  `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Twilio error ${response.status}: ${data.message || JSON.stringify(data)}`);
  }

  console.log(`[Twilio] Message sent — SID: ${data.sid}`);
  return data;
}

// ---------------------------------------------------------------------------
// Claude — generate coaching response with conversation history
// ---------------------------------------------------------------------------

async function getAeonResponse(phone, userMessage) {
  const history = await getConversationHistory(phone);

  const messages = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  console.log(`[Claude] Sending message for ${phone} with ${history.length / 2} prior exchange(s)`);

  const response = await anthropic.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 300,
    system:     AEON_SYSTEM_PROMPT,
    messages,
  });

  const text = response.content[0].text;
  console.log(`[Claude] Aeon response: "${text}"`);
  return text;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Waitlist signup — called by the landing page form
app.post('/waitlist', async (req, res) => {
  const { firstName, phone, businessType } = req.body;

  if (!firstName || !phone || !businessType) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const normalizedPhone = normalizePhone(phone);

  try {
    await saveUserToAirtable(firstName.trim(), normalizedPhone, businessType);
  } catch (err) {
    // Log but don't block — Airtable Users table may not exist yet
    console.error('[Waitlist] Airtable save failed:', err.message);
  }

  try {
    const welcome = `Hey ${firstName.trim()}! I'm Aeon, your AI business coach. I can't wait to help your business grow. What's the #1 goal you want to hit this month? Just reply here to get started.`;
    await sendSms(normalizedPhone, welcome);
  } catch (err) {
    console.error('[Waitlist] Welcome SMS failed:', err.message);
    // Still return success — the record was saved
  }

  res.json({ success: true });
});

// Twilio webhook — incoming SMS
app.post('/sms', async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body?.trim();

  console.log(`[Webhook] Incoming SMS from ${from}: "${body}"`);

  // Acknowledge Twilio immediately with empty TwiML
  res.set('Content-Type', 'text/xml');
  res.send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');

  // Handle opt-out commands (Twilio handles hard STOP automatically;
  // PAUSE/RESUME are soft controls we track ourselves)
  const command = body?.toUpperCase();
  if (command === 'PAUSE') {
    await sendSms(from, "Got it — I'll pause your check-ins. Reply RESUME whenever you're ready to pick back up. Your progress is saved.").catch(console.error);
    return;
  }
  if (command === 'RESUME') {
    await sendSms(from, "Welcome back! Let's pick up where we left off. What's your current focus this week?").catch(console.error);
    return;
  }

  try {
    const aeonReply = await getAeonResponse(from, body);
    await sendSms(from, aeonReply);
    logToAirtable(from, body, aeonReply).catch((err) =>
      console.error(`[Airtable] Logging failed for ${from}:`, err.message)
    );
  } catch (err) {
    console.error(`[Error] Failed to process message from ${from}:`, err.message);
  }
});

app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'Aeonix Ascend' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Aeonix Ascend running on port ${PORT}`);
  console.log(`[Server] Endpoints: POST /waitlist  POST /sms  GET /health`);
});
