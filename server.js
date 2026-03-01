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

// Fix for Render/Railway reverse proxy
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
    const phone = resident.phone;
    if (!phone) {
      results.failed++;
      results.details.push({ resident: resident.name, status: 'skipped', reason: 'No phone number' });
      return;
    }

    const residentResult = { resident: resident.name, unit: resident.unit, phone };

    if (channels.call) {
      try {
        const call = await client.calls.create({
          to: phone, from,
          url: `${baseUrl}/api/twiml/${encodeURIComponent(message)}`,
          statusCallback: `${baseUrl}/api/status`,
          statusCallbackMethod: 'POST',
          machineDetection: 'Enable',
          timeout: 30,
        });
        residentResult.callSid = call.sid;
        residentResult.callStatus = 'initiated';
        callStatuses[call.sid] = { resident: resident.name, status: 'initiated' };
      } catch (err) {
        console.error(`[CALL ERROR] ${phone}: ${err.message} (code: ${err.code})`);
        residentResult.callError = err.message;
        residentResult.callStatus = 'failed';
      }
    }

    if (channels.sms) {
      try {
        const sms = await client.messages.create({
          to: phone, from,
          body: `🚨 ${property ? property + ': ' : ''}${message}`.slice(0, 1600),
        });
        residentResult.smsSid = sms.sid;
        residentResult.smsStatus = sms.status;
      } catch (err) {
        console.error(`[SMS ERROR] ${phone}: ${err.message} (code: ${err.code})`);
        residentResult.smsError = err.message;
        residentResult.smsStatus = 'failed';
      }
    }

    const callOk = !channels.call || residentResult.callStatus === 'initiated';
    const smsOk = !channels.sms || (residentResult.smsStatus && residentResult.smsStatus !== 'failed');
    if (callOk && smsOk) results.sent++;
    else results.failed++;

    results.details.push(residentResult);
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

app.get('/api/twiml/:message', (req, res) => {
  const message = decodeURIComponent(req.params.message);
  res.type('text/xml');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">${escapeXml(message)}</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">This message will now repeat.</Say>
  <Pause length="1"/>
  <Say voice="Polly.Joanna" language="en-US">${escapeXml(message)}</Say>
</Response>`);
});

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

function escapeXml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

app.listen(PORT, () => {
  console.log(`Residial API running on port ${PORT}`);
});

module.exports = app;
