const express  = require('express');
const path     = require('path');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));
app.use(express.json());

// ── Firebase config (served to frontend) ─────────────────────────────────────
app.get('/api/firebase-config', (req, res) => {
  res.json({
    apiKey:            process.env.FIREBASE_API_KEY            || '',
    authDomain:        process.env.FIREBASE_AUTH_DOMAIN        || '',
    projectId:         process.env.FIREBASE_PROJECT_ID         || '',
    storageBucket:     process.env.FIREBASE_STORAGE_BUCKET     || '',
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || '',
    appId:             process.env.FIREBASE_APP_ID             || '',
    measurementId:     process.env.FIREBASE_MEASUREMENT_ID     || '',
  });
});

// ── Nodemailer transporter (Gmail) ────────────────────────────────────────────
function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

// ── Email templates ───────────────────────────────────────────────────────────
function reminderEmailHTML(clientName) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f7f8fa;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0"
      style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <tr><td style="background:#1a2744;padding:24px 32px;">
        <span style="font-size:18px;font-weight:700;color:white;letter-spacing:-0.3px;">&#9679;&nbsp; ClearDue Legal B.V.</span>
      </td></tr>
      <tr><td style="padding:32px;">
        <p style="font-size:15px;font-weight:600;color:#0e1624;margin:0 0 16px;">Dear ${clientName || 'Client'},</p>
        <p style="font-size:14px;color:#4a5568;line-height:1.7;margin:0 0 16px;">
          This is a reminder that your KYC (Know Your Client) file with <strong>ClearDue Legal B.V.</strong>
          is still incomplete. Under the Dutch <em>Wet ter voorkoming van witwassen en financieren van terrorisme</em>
          (Wwft) we are required to finalise your identification before commencing any work on your behalf.
        </p>
        <p style="font-size:14px;color:#4a5568;line-height:1.7;margin:0 0 24px;">
          Please log in to the portal and upload the outstanding documents at your earliest convenience.
          If we do not receive the required documents within <strong>5 business days</strong> we will be
          obliged to cease all activities on your behalf.
        </p>
        <div style="background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:14px 18px;margin-bottom:24px;">
          <p style="font-size:13px;color:#c2410c;font-weight:600;margin:0 0 4px;">Action required</p>
          <p style="font-size:13px;color:#92400e;margin:0;">Please complete your identification documents as soon as possible.</p>
        </div>
        <p style="font-size:13px;color:#8a94a6;border-top:1px solid #e2e5ec;padding-top:20px;margin:0;">
          ClearDue Legal B.V. &middot; Herengracht 400, 1017 BX Amsterdam &middot; info@cleardue.legal<br>
          KvK: 80123456 &middot; BTW: NL003456789B01
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

function engagementLetterEmailHTML(clientName, letterHTML) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f7f8fa;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
  <tr><td align="center">
    <table width="660" cellpadding="0" cellspacing="0"
      style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <tr><td style="background:#1a2744;padding:24px 32px;">
        <span style="font-size:18px;font-weight:700;color:white;letter-spacing:-0.3px;">&#9679;&nbsp; ClearDue Legal B.V.</span>
      </td></tr>
      <tr><td style="padding:32px;">
        <p style="font-size:15px;font-weight:600;color:#0e1624;margin:0 0 8px;">Dear ${clientName || 'Client'},</p>
        <p style="font-size:14px;color:#4a5568;line-height:1.7;margin:0 0 24px;">
          Please find your engagement letter from <strong>ClearDue Legal B.V.</strong> below.
          Review it carefully and countersign to confirm your instructions. Work may only begin after
          KYC is complete and this letter has been countersigned.
        </p>
        <div style="border:1px solid #e2e5ec;border-radius:10px;padding:28px;background:#fafafa;margin-bottom:24px;">
          ${letterHTML}
        </div>
        <div style="background:#e8f5ee;border:1px solid #6ee7b7;border-radius:8px;padding:14px 18px;margin-bottom:24px;">
          <p style="font-size:13px;color:#1e7a4e;font-weight:600;margin:0 0 4px;">Next step</p>
          <p style="font-size:13px;color:#065f46;margin:0;">Reply to this email or log in to the portal to countersign and confirm your instructions.</p>
        </div>
        <p style="font-size:13px;color:#8a94a6;border-top:1px solid #e2e5ec;padding-top:20px;margin:0;">
          ClearDue Legal B.V. &middot; Herengracht 400, 1017 BX Amsterdam &middot; info@cleardue.legal<br>
          KvK: 80123456 &middot; BTW: NL003456789B01
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// ── POST /api/send-reminder ───────────────────────────────────────────────────
app.post('/api/send-reminder', async (req, res) => {
  const { to, clientName } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing recipient email' });

  const t = getTransporter();
  if (!t) {
    console.log(`[Email] GMAIL not configured — skipped reminder to: ${to}`);
    return res.json({ ok: true, skipped: true });
  }
  try {
    await t.sendMail({
      from:    `ClearDue Legal <${process.env.GMAIL_USER}>`,
      to,
      subject: 'Action required: KYC documents outstanding — ClearDue Legal B.V.',
      html:    reminderEmailHTML(clientName),
    });
    console.log(`[Email] Reminder sent to ${to}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Email] Reminder failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/send-engagement-letter ─────────────────────────────────────────
app.post('/api/send-engagement-letter', async (req, res) => {
  const { to, clientName, letterHTML } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing recipient email' });

  const t = getTransporter();
  if (!t) {
    console.log(`[Email] GMAIL not configured — skipped engagement letter to: ${to}`);
    return res.json({ ok: true, skipped: true });
  }
  try {
    await t.sendMail({
      from:    `ClearDue Legal <${process.env.GMAIL_USER}>`,
      to,
      subject: 'Your engagement letter — ClearDue Legal B.V.',
      html:    engagementLetterEmailHTML(clientName, letterHTML || ''),
    });
    console.log(`[Email] Engagement letter sent to ${to}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Email] Engagement letter failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/invite-client ───────────────────────────────────────────────────
app.post('/api/invite-client', async (req, res) => {
  const { to, invitedBy } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing recipient email' });

  const appUrl = process.env.APP_URL || 'https://clearduekyc-production.up.railway.app';
  const t = getTransporter();
  if (!t) {
    console.log(`[Email] GMAIL not configured — skipped invite to: ${to}`);
    return res.json({ ok: true, skipped: true });
  }
  try {
    await t.sendMail({
      from:    `ClearDue Legal <${process.env.GMAIL_USER}>`,
      to,
      subject: 'You have been invited to complete your KYC — ClearDue Legal B.V.',
      html:    inviteEmailHTML(to, invitedBy, appUrl),
    });
    console.log(`[Email] Invite sent to ${to}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Email] Invite failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

function inviteEmailHTML(to, invitedBy, appUrl) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f7f8fa;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0"
      style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <tr><td style="background:#1a2744;padding:24px 32px;">
        <span style="font-size:18px;font-weight:700;color:white;letter-spacing:-0.3px;">&#9679;&nbsp; ClearDue Legal B.V.</span>
      </td></tr>
      <tr><td style="padding:32px;">
        <p style="font-size:15px;font-weight:600;color:#0e1624;margin:0 0 16px;">You have been invited to submit your KYC documents</p>
        <p style="font-size:14px;color:#4a5568;line-height:1.7;margin:0 0 16px;">
          <strong>ClearDue Legal B.V.</strong> has invited you to complete your Know Your Client (KYC)
          identification. This is required under Dutch law (<em>Wwft</em>) before we can commence any
          legal work on your behalf.
        </p>
        <p style="font-size:14px;color:#4a5568;line-height:1.7;margin:0 0 28px;">
          Click the button below to access the secure portal and complete your file.
          The process takes approximately 5 minutes.
        </p>
        <div style="text-align:center;margin:0 0 28px;">
          <a href="${appUrl}"
            style="display:inline-block;background:#1a2744;color:white;text-decoration:none;
                   padding:14px 36px;border-radius:10px;font-size:14px;font-weight:600;letter-spacing:-0.2px;">
            Complete my KYC file &rarr;
          </a>
        </div>
        <p style="font-size:12px;color:#8a94a6;line-height:1.6;margin:0 0 20px;">
          If the button doesn&rsquo;t work, copy and paste this link into your browser:<br>
          <a href="${appUrl}" style="color:#1a2744;">${appUrl}</a>
        </p>
        <p style="font-size:11px;color:#b0b8c6;border-top:1px solid #e2e5ec;padding-top:16px;margin:0;">
          ClearDue Legal B.V. &middot; Herengracht 400, 1017 BX Amsterdam &middot; info@cleardue.legal<br>
          KvK: 80123456 &middot; BTW: NL003456789B01<br>
          This invitation was sent by ${invitedBy || 'ClearDue Legal'}.
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// ── Catch-all → SPA ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'kyc_portal.html'));
});

app.listen(PORT, () => {
  console.log(`ClearDue KYC Portal running on port ${PORT}`);
});
