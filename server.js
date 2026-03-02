/**
 * RESIDIAL — Backend Server
 * Node.js + Express + Twilio Voice + SMS
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3001;

app.set('trust proxy', 1);
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

const alertLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Too many alerts sent. Please wait before sending again.' }
});

const getClient = (accountSid, authToken) => {
  if (!accountSid || !authToken) {
    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
  return twilio(accountSid, authToken);
};

const alertLog = [];
const callStatuses = {};

app.get('/', (req, res) => {
  res.json({ service: 'Residial API', status: 'running', version: '1.0.0' });
});

// ── PHONE NORMALIZER ──
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits[0] === '1') return `+${digits}`;
  if (digits.length > 11) return `+${digits}`;
  return null;
}

function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── TWIML — message passed as query param ──
app.get('/api/twiml', (req, res) => {
  const message = escapeXml(req.query.msg || 'This is an emergency alert from your property management team.');
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">${message}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">Repeating. ${message}</Say>
</Response>`);
});

// ── SEND ALERT ──
app.post('/api/send-alert', alertLimiter, async (req, res) => {
  const { residents, message, type, channels, property, fromPhone, accountSid, authToken } = req.body;

  if (!residents || !Array.isArray(residents) || residents.length === 0)
    return res.status(400).json({ error: 'No residents provided' });
  if (!message || !message.trim())
    return res.status(400).json({ error: 'No message provided' });
  if (!channels || (!channels.call && !channels.sms))
    return res.status(400).json({ error: 'No channels selected' });

  const client = getClient(accountSid, authToken);
  const from = fromPhone || process.env.TWILIO_FROM_NUMBER;
  const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;

  if (!from) return res.status(500).json({ error: 'No Twilio from number configured' });

  const results = { alertId: Date.now().toString(), sent: 0, failed: 0, details: [] };

  const promises = residents.map(async (resident) => {
    const phone = normalizePhone(resident.phone);
    if (!phone) {
      results.failed++;
      results.details.push({ resident: resident.name, status: 'skipped', reason: `Bad number: ${resident.phone}` });
      return;
    }

    console.log(`[DIALING] ${resident.name} → ${phone}`);
    const r = { resident: resident.name, unit: resident.unit, phone };
    let anyFailed = false;

    if (channels.call) {
      try {
        // Pass message as query param — simple and reliable
        const twimlUrl = `${baseUrl}/api/twiml?msg=${encodeURIComponent(message.slice(0, 500))}`;
        const call = await client.calls.create({
          to: phone,
          from,
          url: twimlUrl,
          statusCallback: `${baseUrl}/api/status`,
          statusCallbackMethod: 'POST',
          timeout: 30,
        });
        r.callSid = call.sid;
        r.callStatus = 'initiated';
        callStatuses[call.sid] = { resident: resident.name, phone, status: 'initiated' };
        console.log(`[CALL OK] ${resident.name} (${phone}) → ${call.sid}`);
      } catch (err) {
        console.error(`[CALL FAIL] ${resident.name} (${phone}): ${err.message} (${err.code})`);
        r.callError = err.message;
        r.callStatus = 'failed';
        anyFailed = true;
      }
    }

    if (channels.sms) {
      try {
        const body = `🚨 ${property ? property + ': ' : ''}${message}`.slice(0, 1600);
        const sms = await client.messages.create({ to: phone, from, body });
        r.smsSid = sms.sid;
        r.smsStatus = sms.status;
        console.log(`[SMS OK] ${resident.name} (${phone}) → ${sms.sid}`);
      } catch (err) {
        console.error(`[SMS FAIL] ${resident.name} (${phone}): ${err.message}`);
        r.smsError = err.message;
        r.smsStatus = 'failed';
        anyFailed = true;
      }
    }

    if (anyFailed) results.failed++;
    else results.sent++;
    results.details.push(r);
  });

  await Promise.allSettled(promises);

  alertLog.unshift({
    ...results, type, property, message, channels,
    timestamp: new Date().toISOString(),
    residentCount: residents.length,
  });

  console.log(`[ALERT] ${type} | ${residents.length} residents | ${results.sent} sent | ${results.failed} failed`);
  res.json(results);
});

// ── STATUS WEBHOOK ──
app.post('/api/status', (req, res) => {
  const { CallSid, CallStatus, To } = req.body;
  if (CallSid && callStatuses[CallSid]) {
    callStatuses[CallSid].status = CallStatus;
    callStatuses[CallSid].updatedAt = new Date().toISOString();
  }
  console.log(`[STATUS] ${To} — ${CallStatus}`);
  res.status(200).end();
});

app.get('/api/history', (req, res) => res.json(alertLog.slice(0, 50)));

app.listen(PORT, () => {
  console.log(`Residial API running on port ${PORT}`);
});

module.exports = app;
