/**
 * ╔══════════════════════════════════════════════════════════╗
 * ║             RESIDIAL — Backend Server                   ║
 * ║    AI-Powered Property Emergency Alert System           ║
 * ║    Node.js + Express + Twilio Voice + Twilio SMS        ║
 * ╚══════════════════════════════════════════════════════════╝
 *
 * SETUP:
 *   1. npm install
 *   2. Copy .env.example to .env and fill in your values
 *   3. node server.js
 *
 * DEPLOY TO: Railway, Render, Heroku, DigitalOcean, or any VPS
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;

// ── MIDDLEWARE ──────────────────────────────────────────────
app.use(cors({ origin: '*' })); // Restrict in production
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting — max 10 alert sends per hour per IP
const alertLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many alerts sent. Please wait before sending again.' }
});

// ── TWILIO CLIENT ───────────────────────────────────────────
const getClient = (accountSid, authToken) => {
  if (!accountSid || !authToken) {
    // Fall back to env vars
    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return twilio(accountSid, authToken);
};

// ── IN-MEMORY STORE (use a DB in production) ────────────────
const alertLog = [];
const callStatuses = {}; // callSid -> status

// ── HEALTH CHECK ────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'Residial API',
    status: 'running',
    version: '1.0.0',
    endpoints: [
      'POST /api/send-alert',
      'GET  /api/history',
      'POST /api/status (Twilio webhook)',
      'GET  /api/twiml/:message (Twilio TwiML voice script)',
    ]
  });
});

// ── SEND ALERT ──────────────────────────────────────────────
/**
 * POST /api/send-alert
 * Body: {
 *   residents: [{ name, unit, phone, email }],
 *   message: string,
 *   type: 'fire' | 'water' | 'power' | 'gas' | 'flood' | 'general',
 *   channels: { call: boolean, sms: boolean },
 *   property: string,
 *   fromPhone: string (optional, falls back to env)
 * }
 */
app.post('/api/send-alert', alertLimiter, async (req, res) => {
  const { residents, message, type, channels, property, fromPhone,
          accountSid, authToken } = req.body;

  // Validate
  if (!residents || !Array.isArray(residents) || residents.length === 0) {
    return res.status(400).json({ error: 'No residents provided' });
  }
  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'No message provided' });
  }
  if (!channels || (!channels.call && !channels.sms)) {
    return res.status(400).json({ error: 'No channels selected' });
  }

  const client = getClient(accountSid, authToken);
  const from = fromPhone || process.env.TWILIO_FROM_NUMBER;
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;

  if (!from) {
    return res.status(500).json({ error: 'No Twilio from number configured' });
  }

  const alertId = Date.now().toString();
  const results = { alertId, sent: 0, failed: 0, details: [] };

  // Encode message for URL use in TwiML endpoint
  const encodedMsg = encodeURIComponent(message);

  // ── SEND TO EACH RESIDENT ──
  const promises = residents.map(async (resident) => {
    const phone = resident.phone;
    if (!phone) {
      results.failed++;
      results.details.push({ resident: resident.name, status: 'skipped', reason: 'No phone number' });
      return;
    }

    const residentResult = { resident: resident.name, unit: resident.unit, phone };

    // ── VOICE CALL ──
    if (channels.call) {
      try {
        const call = await client.calls.create({
          to: phone,
          from: from,
          // TwiML that speaks the message
          url: `${baseUrl}/api/twiml/${encodeURIComponent(message)}`,
          statusCallback: `${baseUrl}/api/status`,
          statusCallbackMethod: 'POST',
          statusCallbackEvent: ['completed', 'no-answer', 'failed', 'busy'],
          machineDetection: 'Enable', // Handle voicemail
          timeout: 30,
        });
        residentResult.callSid = call.sid;
        residentResult.callStatus = 'initiated';
        callStatuses[call.sid] = { resident: resident.name, status: 'initiated' };
      } catch (err) {
        residentResult.callError = err.message;
        residentResult.callStatus = 'failed';
      }
    }

    // ── SMS ──
    if (channels.sms) {
      try {
        // SMS has 160 char limit per segment — truncate if needed for cost
        const smsBody = `🚨 ${property ? property + ': ' : ''}${message}`.slice(0, 1600);
        const sms = await client.messages.create({
          to: phone,
          from: from,
          body: smsBody,
        });
        residentResult.smsSid = sms.sid;
        residentResult.smsStatus = sms.status;
      } catch (err) {
        residentResult.smsError = err.message;
        residentResult.smsStatus = 'failed';
      }
    }

    // Count as sent if at least one channel succeeded
    const callOk = !channels.call || residentResult.callStatus === 'initiated';
    const smsOk = !channels.sms || (residentResult.smsStatus && residentResult.smsStatus !== 'failed');
    if (callOk && smsOk) results.sent++;
    else results.failed++;

    results.details.push(residentResult);
  });

  // Run all in parallel (Twilio handles rate limits internally)
  await Promise.allSettled(promises);

  // Log to history
  alertLog.unshift({
    ...results,
    type, property, message,
    channels, timestamp: new Date().toISOString(),
    residentCount: residents.length,
  });

  console.log(`[ALERT] ${type} | ${residents.length} residents | ${results.sent} sent | ${results.failed} failed`);
  res.json(results);
});

// ── TWIML VOICE SCRIPT ──────────────────────────────────────
/**
 * GET /api/twiml/:message
 * Returns TwiML XML for Twilio to speak the alert message
 */
app.get('/api/twiml/:message', (req, res) => {
  const message = decodeURIComponent(req.params.message);
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">
    ${escapeXml(message)}
  </Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">
    This message will now repeat.
  </Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">
    ${escapeXml(message)}
  </Say>
</Response>`);
});

// ── STATUS WEBHOOK ──────────────────────────────────────────
/**
 * POST /api/status
 * Twilio calls this when a call's status changes
 */
app.post('/api/status', (req, res) => {
  const { CallSid, CallStatus, To } = req.body;
  if (CallSid && callStatuses[CallSid]) {
    callStatuses[CallSid].status = CallStatus;
    callStatuses[CallSid].updatedAt = new Date().toISOString();
  }
  console.log(`[STATUS] ${To} — ${CallStatus}`);
  res.status(200).end();
});

// ── ALERT HISTORY ───────────────────────────────────────────
app.get('/api/history', (req, res) => {
  res.json(alertLog.slice(0, 50));
});

// ── CALL STATUSES ───────────────────────────────────────────
app.get('/api/call-statuses', (req, res) => {
  res.json(callStatuses);
});

// ── TEST ENDPOINT (single number) ───────────────────────────
/**
 * POST /api/test-call
 * Body: { phone, message, accountSid, authToken, fromPhone }
 * Send a test call to verify Twilio is working
 */
app.post('/api/test-call', async (req, res) => {
  const { phone, message, accountSid, authToken, fromPhone } = req.body;
  if (!phone || !message) return res.status(400).json({ error: 'phone and message required' });

  const client = getClient(accountSid, authToken);
  const from = fromPhone || process.env.TWILIO_FROM_NUMBER;
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;

  try {
    const call = await client.calls.create({
      to: phone, from,
      url: `${baseUrl}/api/twiml/${encodeURIComponent(message)}`,
      timeout: 30
    });
    res.json({ success: true, callSid: call.sid, status: call.status });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.code });
  }
});

// ── HELPERS ─────────────────────────────────────────────────
function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── START ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║     Residial API Server Running      ║
║     http://localhost:${PORT}            ║
╚══════════════════════════════════════╝
  `);
});

module.exports = app;
