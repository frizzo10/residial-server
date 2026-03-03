/**
 * RESIDIAL — Backend Server
 * Node.js + Express + Twilio Voice + SMS
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');
const sgMail = require('@sendgrid/mail');
sgMail.setApiKey(process.env.SENDGRID_API_KEY || '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');

const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://frizzo1_db_user:Deepbluesea1@cluster0.z0krsz8.mongodb.net/?appName=Cluster0';
const mongoClient = new MongoClient(MONGO_URI);
let db;

mongoClient.connect()
  .then(() => {
    db = mongoClient.db('residial');
    console.log('[MONGO] Connected to MongoDB');
  })
  .catch(err => console.error('[MONGO] Connection failed:', err.message));

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
  const msgEn = escapeXml(req.query.msg || 'This is an emergency alert from your property management team.');
  const msgEs = escapeXml(req.query.mse || '');
  const lang  = req.query.lang || 'en';
  res.type('text/xml');

  let xml = `<?xml version="1.0" encoding="UTF-8"?>\n<Response>\n  <Pause length="1"/>\n`;

  if ((lang === 'en' || lang === 'both') && msgEn) {
    xml += `  <Say voice="Polly.Joanna" language="en-US">${msgEn}</Say>\n  <Pause length="1"/>\n`;
  }
  if ((lang === 'es' || lang === 'both') && msgEs) {
    xml += `  <Say voice="Polly.Lupe" language="es-US">${msgEs}</Say>\n  <Pause length="1"/>\n`;
  }
  if ((lang === 'en' || lang === 'both') && msgEn) {
    xml += `  <Say voice="Polly.Joanna" language="en-US">Repeating. ${msgEn}</Say>\n`;
  }
  if ((lang === 'es' || lang === 'both') && msgEs) {
    xml += `  <Say voice="Polly.Lupe" language="es-US">Repitiendo. ${msgEs}</Say>\n`;
  }

  xml += `</Response>`;
  res.send(xml);
});

// ── SEND ALERT ──
app.post('/api/send-alert', alertLimiter, async (req, res) => {
  const { residents, message, messageEn, messageEs, language, type, channels, property, fromPhone, accountSid, authToken } = req.body;

  const engMsg = messageEn || message || '';
  const espMsg = messageEs || '';
  const lang   = language || 'en';

  if (!residents || !Array.isArray(residents) || residents.length === 0)
    return res.status(400).json({ error: 'No residents provided' });
  if (!engMsg && !espMsg)
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
        const twimlUrl = `${baseUrl}/api/twiml?lang=${lang}&msg=${encodeURIComponent(engMsg.slice(0,500))}&mse=${encodeURIComponent(espMsg.slice(0,500))}`;
        const call = await client.calls.create({
          to: phone, from, url: twimlUrl,
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
      // English SMS
      if (lang === 'en' || lang === 'both') {
        try {
          const body = `🚨 ${property ? property + ': ' : ''}${engMsg}`.slice(0, 1600);
          const sms = await client.messages.create({ to: phone, from, body });
          r.smsSid = sms.sid; r.smsStatus = sms.status;
          console.log(`[SMS EN OK] ${resident.name} (${phone}) → ${sms.sid}`);
        } catch (err) {
          console.error(`[SMS EN FAIL] ${resident.name}: ${err.message}`);
          r.smsStatus = 'failed'; anyFailed = true;
        }
      }
      // Spanish SMS
      if ((lang === 'es' || lang === 'both') && espMsg) {
        try {
          const body = `🚨 ${property ? property + ': ' : ''}${espMsg}`.slice(0, 1600);
          const sms = await client.messages.create({ to: phone, from, body });
          r.smsSidEs = sms.sid; r.smsStatusEs = sms.status;
          console.log(`[SMS ES OK] ${resident.name} (${phone}) → ${sms.sid}`);
        } catch (err) {
          console.error(`[SMS ES FAIL] ${resident.name}: ${err.message}`);
          r.smsStatusEs = 'failed'; anyFailed = true;
        }
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

// ── SAVE SIGNUP ──
app.post('/api/signup', async (req, res) => {
  const { fname, lname, company, email, phone, doors, state } = req.body;
  if (!fname || !phone) return res.status(400).json({ error: 'Missing required fields' });
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const signup = {
      fname, lname, company, email, phone, doors, state,
      createdAt: new Date(),
      trialStarted: new Date(),
      trialEnds: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
      status: 'trial'
    };
    await db.collection('signups').insertOne(signup);
    console.log(`[SIGNUP] ${fname} ${lname} — ${company} (${phone})`);

    // Send confirmation email to owner
    try {
      await sgMail.send({
        to: 'frizzo1@gmail.com',
        from: 'noreply@residial.net',
        subject: `New Trial Signup: ${fname} ${lname} — ${company}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f5f0e8">
            <h2 style="color:#08111f;font-size:24px;margin-bottom:4px">New Trial Signup 🎉</h2>
            <p style="color:#6b7a8d;margin-bottom:24px">Someone just signed up for a Residial free trial.</p>
            <table style="width:100%;border-collapse:collapse;background:#fff;border-radius:12px;overflow:hidden">
              <tr><td style="padding:12px 16px;border-bottom:1px solid #eee;font-weight:600;width:140px">Name</td><td style="padding:12px 16px;border-bottom:1px solid #eee">${fname} ${lname}</td></tr>
              <tr><td style="padding:12px 16px;border-bottom:1px solid #eee;font-weight:600">Company</td><td style="padding:12px 16px;border-bottom:1px solid #eee">${company}</td></tr>
              <tr><td style="padding:12px 16px;border-bottom:1px solid #eee;font-weight:600">Phone</td><td style="padding:12px 16px;border-bottom:1px solid #eee">${phone}</td></tr>
              <tr><td style="padding:12px 16px;border-bottom:1px solid #eee;font-weight:600">Doors</td><td style="padding:12px 16px;border-bottom:1px solid #eee">${doors}</td></tr>
              <tr><td style="padding:12px 16px;font-weight:600">State</td><td style="padding:12px 16px">${state}</td></tr>
            </table>
            <p style="margin-top:24px;color:#6b7a8d;font-size:13px">Trial ends in 14 days. View all signups at <a href="https://musical-peony-b84b2f.netlify.app/admin.html">admin dashboard</a>.</p>
          </div>
        `
      });
      console.log(`[EMAIL] Signup notification sent for ${fname} ${lname}`);
      // Send confirmation to customer
      if(email) {
        await sgMail.send({
          to: email,
          from: 'noreply@residial.net',
          subject: 'Welcome to Residial — Your 14-Day Free Trial Has Started',
          html: `
            <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:32px;background:#f5f0e8">
              <h1 style="font-family:Georgia,serif;color:#08111f;font-size:32px;margin-bottom:4px">Welcome to Resid<span style="color:#1a5fff">ial</span></h1>
              <p style="color:#6b7a8d;margin-bottom:24px">Your 14-day free trial has started.</p>
              <div style="background:#fff;border-radius:12px;padding:24px;margin-bottom:24px">
                <p style="color:#08111f;font-size:16px;margin-bottom:16px">Hi ${fname},</p>
                <p style="color:#2a3a4a;margin-bottom:16px">You're all set! Your Residial account is ready. You can now send emergency alerts to all your residents simultaneously via voice call and SMS — in under 10 seconds.</p>
                <a href="https://residial.net/pm-dashboard.html" style="display:inline-block;background:#1a5fff;color:#fff;padding:12px 24px;border-radius:100px;text-decoration:none;font-weight:600;margin-bottom:16px">Open Your Dashboard →</a>
                <p style="color:#6b7a8d;font-size:13px;margin:0">Your trial ends in 14 days. No credit card required until then.</p>
              </div>
              <div style="background:#fff;border-radius:12px;padding:24px;margin-bottom:24px">
                <p style="font-weight:600;color:#08111f;margin-bottom:12px">Getting started checklist:</p>
                <p style="color:#2a3a4a;margin-bottom:8px">✅ Account created</p>
                <p style="color:#2a3a4a;margin-bottom:8px">⬜ Upload your resident list (CSV or Excel)</p>
                <p style="color:#2a3a4a;margin-bottom:8px">⬜ Send your first test alert</p>
                <p style="color:#2a3a4a;margin-bottom:0">⬜ Add Residial fee to resident leases</p>
              </div>
              <p style="color:#6b7a8d;font-size:12px;text-align:center">Questions? Reply to this email or visit residial.net</p>
            </div>
          `
        });
        console.log(`[EMAIL] Confirmation sent to ${email}`);
      }
    } catch(emailErr) {
      console.error('[EMAIL ERROR]', emailErr.message);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('[SIGNUP ERROR]', err.message);
    res.status(500).json({ error: 'Failed to save signup' });
  }
});

// ── GET ALL SIGNUPS (admin) ──
app.get('/api/signups', async (req, res) => {
  const key = req.headers['x-admin-key'];
  if (key !== 'residial-admin-2026') return res.status(401).json({ error: 'Unauthorized' });
  try {
    if (!db) return res.status(503).json({ error: 'Database not connected' });
    const signups = await db.collection('signups').find({}).sort({ createdAt: -1 }).toArray();
    res.json(signups);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch signups' });
  }
});

app.listen(PORT, () => {
  console.log(`Residial API running on port ${PORT}`);
});

module.exports = app;
