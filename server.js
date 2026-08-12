require('dotenv').config();
const express = require('express');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');

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

// First-ever conversation with a new user. Goal: make them feel welcomed,
// learn about them and their business, and land on ONE specific, achievable
// goal for the next 1-2 weeks. Skips questions we already have answers to
// (e.g. name/business collected on the signup form).
function buildOnboardingPrompt(knownName, knownBusiness) {
  const known = [];
  if (knownName)     known.push(`Their name is ${knownName}.`);
  if (knownBusiness) known.push(`Their business: ${knownBusiness}.`);

  return `You are Aeon, an AI business coach meeting a brand new client for the first time via text message.

${known.length ? `Here's what you already know about them:\n${known.join('\n')}\n\n` : ''}Be warm, curious, and encouraging — this is a first impression. Your job right now is to learn, one thing at a time, whatever you don't already know:
1. Their name (skip this if already known — don't ask again)
2. What their business does (skip this if already known — don't ask again)
3. Their #1 goal right now — something specific and achievable in the next 1-2 weeks

If you already know their name and business, greet them by name and go straight to asking about their goal — don't waste a message re-asking what you already know.

Ask ONLY ONE question per message — never stack multiple questions. Keep responses under 300 characters.

Once you have a clear, specific goal from them, respond with a short encouraging wrap-up, and include this exact tag at the very end of your message on its own line:
[GOAL: <the specific goal in a few words>]

Do not include the [GOAL: ...] tag until you actually have a concrete goal from the user — keep asking questions until you do.`;
}

// Every conversation after onboarding. Goal-aware: knows the user's current
// goal, checks progress on it, and only sets a new one once it's done.
function buildCoachingPrompt(currentGoal) {
  return `You are Aeon, an elite business coach and strategic advisor. You help entrepreneurs, executives, and ambitious professionals achieve breakthrough results.

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

The user's current goal is: "${currentGoal || 'not yet set'}"

Check in on progress toward this goal when it's relevant to the conversation. Ask ONLY ONE question per message — never stack multiple questions or numbered options in a single text.

If the user reports they've fully completed this goal, congratulate them specifically, then propose ONE new specific, achievable goal for the next 1-2 weeks. Include this exact tag at the very end of your message on its own line:
[GOAL: <the new goal in a few words>]

If they're still working on the current goal, do not include a [GOAL: ...] tag — just coach them normally.

Always end with either ONE specific action step OR ONE thought-provoking question — never both, never more than one of either. Keep responses under 300 characters when possible to fit SMS format.`;
}

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
// Users table fields (as confirmed):
//   Name          (Single line text) — primary field
//   Phone         (Single line text)
//   Business Type (Single line text)
//   SignupDate    (Date)
// ---------------------------------------------------------------------------

async function saveUserToAirtable(firstName, phone, businessType) {
  const payload = {
    records: [{
      fields: {
        Name:            firstName,
        Phone:           phone,
        'Business Type': businessType,
        SignupDate:      new Date().toISOString(),
        Status:          'trial',
        Onboarded:       false,
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
// Onboarding opener — sent the moment someone signs up, before they've
// texted in at all. Uses the same onboarding brain as the /sms webhook so
// the conversation feels continuous, and skips questions we already know
// the answer to from the signup form.
// ---------------------------------------------------------------------------

async function sendOnboardingOpener(phone, firstName, businessType) {
  const systemPrompt = buildOnboardingPrompt(firstName, businessType);

  const response = await anthropic.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 300,
    system:     systemPrompt,
    messages: [
      { role: 'user', content: '(New user just signed up on the website. Greet them warmly by name and ask your first onboarding question.)' },
    ],
  });

  const rawText = response.content[0].text;
  const { cleanText } = extractGoalTag(rawText); // strip any stray tag just in case

  await sendSms(phone, cleanText);

  // Log it so it's part of conversation history for future context —
  // there's no real "inbound message" here, so we mark it as a system event.
  logToAirtable(phone, '(new signup — onboarding opener sent)', cleanText).catch((err) =>
    console.error(`[Airtable] Logging failed for ${phone}:`, err.message)
  );

  return cleanText;
}

// ---------------------------------------------------------------------------
// Airtable — find or create a user by phone, track onboarding + goal
// ---------------------------------------------------------------------------

async function getUserByPhone(phone) {
  const filter = encodeURIComponent(`{Phone}="${phone}"`);
  const res = await airtableFetch(`/Users?filterByFormula=${filter}&maxRecords=1`);
  if (!res.ok) {
    console.warn(`[Airtable] User lookup failed (${res.status}) for ${phone}`);
    return null;
  }
  const data = await res.json();
  return data.records?.[0] || null;
}

async function createUserByPhone(phone) {
  const payload = {
    records: [{
      fields: {
        Phone:      phone,
        Status:     'trial',
        Onboarded:  false,
        SignupDate: new Date().toISOString(),
      },
    }],
  };
  const res = await airtableFetch('/Users', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Airtable Users create error ${res.status}: ${JSON.stringify(err)}`);
  }
  const data = await res.json();
  console.log(`[Airtable] New user created for ${phone}`);
  return data.records[0];
}

// Saves a new goal and marks the user onboarded (safe to call every time —
// flipping Onboarded to true on an already-onboarded user is a no-op).
async function saveUserGoal(recordId, goal) {
  await airtableFetch(`/Users/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: { CurrentGoal: goal, Onboarded: true } }),
  });
  console.log(`[Airtable] Goal saved: "${goal}"`);
}

// Pulls a [GOAL: ...] tag out of Aeon's raw reply, if present, and returns
// both the tag-free text (safe to text the user) and the extracted goal.
function extractGoalTag(rawText) {
  const match = rawText.match(/\[GOAL:\s*(.+?)\]/i);
  const cleanText = rawText.replace(/\[GOAL:\s*.+?\]/i, '').trim();
  return { cleanText, goal: match ? match[1].trim() : null };
}

// ---------------------------------------------------------------------------
// Airtable — active users + last message timestamp
// ---------------------------------------------------------------------------

async function getActiveUsers() {
  const filter = encodeURIComponent(`{Status}="active"`);
  const res = await airtableFetch(`/Users?filterByFormula=${filter}`);
  if (!res.ok) {
    console.warn(`[Airtable] Failed to fetch active users (${res.status})`);
    return [];
  }
  const data = await res.json();
  return data.records || [];
}

async function getLastMessageTimestamp(phone) {
  const filter = encodeURIComponent(`{Phone}="${phone}"`);
  const qs = `filterByFormula=${filter}&sort[0][field]=Timestamp&sort[0][direction]=desc&maxRecords=1`;
  const res = await airtableFetch(`/Conversations?${qs}`);
  if (!res.ok) return null;
  const data = await res.json();
  const record = data.records?.[0];
  return record ? new Date(record.fields.Timestamp) : null;
}

async function updateLastCheckIn(recordId) {
  await airtableFetch(`/Users/${recordId}`, {
    method: 'PATCH',
    body: JSON.stringify({ fields: { LastCheckIn: new Date().toISOString() } }),
  });
}

// ---------------------------------------------------------------------------
// Proactive outreach
// ---------------------------------------------------------------------------

async function runScheduledCheckIns() {
  const users = await getActiveUsers();
  for (const user of users) {
    const phone = user.fields.Phone;
    const name = user.fields.Name || 'there';
    try {
      const goal = user.fields.CurrentGoal;
      const checkIn = goal
        ? `Hey ${name}, checking in on your goal — "${goal}". What progress have you made?`
        : `Hey ${name}, checking in — what's one thing you moved forward on since we last talked?`;
      await sendSms(phone, checkIn);
      await updateLastCheckIn(user.id);
      console.log(`[Proactive] Check-in sent to ${phone}`);
    } catch (err) {
      console.error(`[Proactive] Check-in failed for ${phone}:`, err.message);
    }
  }
}

async function runGhostDetection() {
  const users = await getActiveUsers();
  const now = Date.now();
  const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
  const today = new Date().toDateString();

  for (const user of users) {
    const phone = user.fields.Phone;
    const name = user.fields.Name || 'there';
    const lastCheckIn = user.fields.LastCheckIn ? new Date(user.fields.LastCheckIn).toDateString() : null;

    if (lastCheckIn === today) continue; // already texted today via scheduled check-in, skip

    try {
      const lastMsg = await getLastMessageTimestamp(phone);
      if (lastMsg && (now - lastMsg.getTime()) >= THREE_DAYS_MS) {
        const nudge = `Hey ${name}, haven't heard from you in a few days — everything okay? What's been getting in the way?`;
        await sendSms(phone, nudge);
        console.log(`[Proactive] Ghost re-engagement sent to ${phone}`);
      }
    } catch (err) {
      console.error(`[Proactive] Ghost check failed for ${phone}:`, err.message);
    }
  }
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
  // Find (or create) this user's Airtable record so we know whether
  // they've been onboarded yet and what their current goal is.
  let user = await getUserByPhone(phone);
  if (!user) {
    user = await createUserByPhone(phone);
  }

  const isOnboarding = !user.fields.Onboarded;
  const systemPrompt = isOnboarding
    ? buildOnboardingPrompt(user.fields.Name, user.fields['Business Type'])
    : buildCoachingPrompt(user.fields.CurrentGoal);

  const history = await getConversationHistory(phone);
  const messages = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  console.log(`[Claude] Sending message for ${phone} (${isOnboarding ? 'onboarding' : 'coaching'}) with ${history.length / 2} prior exchange(s)`);

  const response = await anthropic.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 300,
    system:     systemPrompt,
    messages,
  });

  const rawText = response.content[0].text;
  const { cleanText, goal } = extractGoalTag(rawText);

  if (goal) {
    await saveUserGoal(user.id, goal).catch((err) =>
      console.error(`[Airtable] Failed to save goal for ${phone}:`, err.message)
    );
  }

  console.log(`[Claude] Aeon response: "${cleanText}"`);
  return cleanText;
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
    await sendOnboardingOpener(normalizedPhone, firstName.trim(), businessType);
  } catch (err) {
    console.error('[Waitlist] Onboarding opener failed:', err.message);
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

// Manual trigger for testing — hit this in a browser or with curl to fire
// check-ins/ghost detection on demand instead of waiting for the cron time.
// TODO: remove or protect with a secret before broad rollout.
app.get('/test-checkin', async (_req, res) => {
  await runScheduledCheckIns();
  res.json({ triggered: 'scheduled check-ins' });
});

app.get('/test-ghost', async (_req, res) => {
  await runGhostDetection();
  res.json({ triggered: 'ghost detection' });
});

// Mon/Wed/Fri at 9am Central — scheduled check-ins
cron.schedule('0 9 * * 1,3,5', runScheduledCheckIns, { timezone: 'America/Chicago' });

// Every day at 10am Central — ghost detection (3-day silence threshold)
cron.schedule('0 10 * * *', runGhostDetection, { timezone: 'America/Chicago' });

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[Server] Aeonix Ascend running on port ${PORT}`);
  console.log(`[Server] Endpoints: POST /waitlist  POST /sms  GET /health`);
});
