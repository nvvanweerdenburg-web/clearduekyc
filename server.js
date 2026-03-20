const express    = require('express');
const path       = require('path');
const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const fs         = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '2mb' }));

// ── EU Sanctions list — loaded once at startup ────────────────────────────────
let _sanctionsNames = null; // array of normalized strings
function loadSanctions() {
  try {
    const raw  = fs.readFileSync(path.join(__dirname, 'sanctions.json'), 'utf8');
    const data = JSON.parse(raw);
    _sanctionsNames = data.names || [];
    console.log(`[Sanctions] Loaded ${_sanctionsNames.length} entries (${data.source || 'EU list'}, ${data.generated || ''})`);
  } catch(e) {
    console.warn('[Sanctions] Could not load sanctions.json:', e.message);
    _sanctionsNames = [];
  }
}
loadSanctions();

function normalizeName(s) {
  if (!s) return '';
  // Lowercase, remove diacritics, keep alphanumeric + spaces
  s = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return s.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Fuzzy token-based match: returns matching sanctions entries for a given name
function checkSanctions(name) {
  if (!_sanctionsNames || !_sanctionsNames.length || !name) return [];
  const norm   = normalizeName(name);
  if (norm.length < 3) return [];
  const tokens = norm.split(' ').filter(t => t.length >= 3);
  if (!tokens.length) return [];

  const matches = [];
  // Check each sanctions entry
  for (const entry of _sanctionsNames) {
    // Full name substring match (normalized name fully contained in entry or entry fully in name)
    if (entry === norm || entry.includes(norm) || norm.includes(entry)) {
      // Make sure the matching part is at least 5 chars to avoid false positives
      const matched = entry === norm ? norm : (entry.includes(norm) ? norm : entry);
      if (matched.length >= 5) { matches.push(entry); if (matches.length >= 5) break; continue; }
    }
    // Token match: if ALL significant tokens from the query appear in the sanctions entry
    // (allows for variations in name order/middle names)
    const sigTokens = tokens.filter(t => t.length >= 4 &&
      !['van','von','den','der','bin','bint','abu','ibn','the','and'].includes(t));
    if (sigTokens.length >= 2) {
      const allMatch = sigTokens.every(t => entry.includes(t));
      if (allMatch) { matches.push(entry); if (matches.length >= 5) break; }
    }
  }
  return matches;
}

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

// ── Email sending — Resend preferred, Gmail fallback ─────────────────────────
// Priority: RESEND_API_KEY → GMAIL_USER+GMAIL_APP_PASSWORD → log only

async function sendEmail({ to, subject, html }) {
  // 1. Try Resend
  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from   = process.env.RESEND_FROM || 'ClearDue Legal <onboarding@resend.dev>';
    const result = await resend.emails.send({ from, to, subject, html });
    if (result.error) throw new Error(result.error.message || JSON.stringify(result.error));
    console.log(`[Email/Resend] Sent to ${to}: ${subject}`);
    return;
  }

  // 2. Try Gmail
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({
      from: `ClearDue Legal <${process.env.GMAIL_USER}>`,
      to, subject, html,
    });
    console.log(`[Email/Gmail] Sent to ${to}: ${subject}`);
    return;
  }

  // 3. No provider configured
  console.warn(`[Email] NOT SENT — no email provider configured. Set RESEND_API_KEY or GMAIL_USER+GMAIL_APP_PASSWORD in Railway Variables.`);
  console.warn(`[Email] Would have sent to: ${to} | Subject: ${subject}`);
  throw new Error('No email provider configured. Add RESEND_API_KEY to Railway Variables.');
}

// ── GET /api/email-status — diagnostic ───────────────────────────────────────
app.get('/api/email-status', (req, res) => {
  const hasResend = !!process.env.RESEND_API_KEY;
  const hasGmail  = !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
  res.json({
    provider:    hasResend ? 'resend' : hasGmail ? 'gmail' : 'none',
    resend:      hasResend,
    gmail:       hasGmail,
    configured:  hasResend || hasGmail,
    message:     hasResend ? '✓ Resend configured'
               : hasGmail  ? '✓ Gmail configured'
               :             '✗ No email provider — add RESEND_API_KEY to Railway Variables',
  });
});

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

function engagementLetterEmailHTML(clientName, letterHTML, letterId, lawyerEmail, appUrl) {
  const base = appUrl || process.env.APP_URL || 'https://clearduekyc-production.up.railway.app';
  const approveUrl = `${base}?letter_action=approve&lid=${encodeURIComponent(letterId||'')}&lawyer=${encodeURIComponent(lawyerEmail||'')}`;
  const denyUrl    = `${base}?letter_action=deny&lid=${encodeURIComponent(letterId||'')}&lawyer=${encodeURIComponent(lawyerEmail||'')}`;
  const actionButtons = letterId ? `
        <div style="text-align:center;margin:0 0 28px;display:flex;gap:12px;justify-content:center;flex-wrap:wrap;">
          <a href="${approveUrl}"
            style="display:inline-block;background:#15803d;color:white;text-decoration:none;
                   padding:13px 32px;border-radius:10px;font-size:14px;font-weight:600;letter-spacing:-0.2px;">
            ✓ Approve engagement letter
          </a>
          <a href="${denyUrl}"
            style="display:inline-block;background:#b91c1c;color:white;text-decoration:none;
                   padding:13px 32px;border-radius:10px;font-size:14px;font-weight:600;letter-spacing:-0.2px;">
            ✕ Deny / request changes
          </a>
        </div>` : `
        <div style="background:#e8f5ee;border:1px solid #6ee7b7;border-radius:8px;padding:14px 18px;margin-bottom:24px;">
          <p style="font-size:13px;color:#1e7a4e;font-weight:600;margin:0 0 4px;">Next step</p>
          <p style="font-size:13px;color:#065f46;margin:0;">Log in to the portal to approve or deny this engagement letter.</p>
        </div>`;
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
          Review it carefully and use the buttons below to approve or deny.
          Work may only begin after KYC is complete and this letter has been approved.
        </p>
        <div style="border:1px solid #e2e5ec;border-radius:10px;padding:28px;background:#fafafa;margin-bottom:24px;">
          ${letterHTML}
        </div>
        ${actionButtons}
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
  try {
    await sendEmail({ to, subject: 'Action required: KYC documents outstanding — ClearDue Legal B.V.', html: reminderEmailHTML(clientName) });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Email] Reminder failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/send-engagement-letter ─────────────────────────────────────────
app.post('/api/send-engagement-letter', async (req, res) => {
  const { to, clientName, letterHTML, letterId, lawyerEmail } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing recipient email' });
  const appUrl = process.env.APP_URL || 'https://clearduekyc-production.up.railway.app';
  try {
    await sendEmail({ to, subject: 'Your engagement letter — ClearDue Legal B.V.', html: engagementLetterEmailHTML(clientName, letterHTML || '', letterId, lawyerEmail, appUrl) });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Email] Engagement letter failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/notify-lawyer ───────────────────────────────────────────────────
app.post('/api/notify-lawyer', async (req, res) => {
  const { to, clientName, action, letterId } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing lawyer email' });
  const actionLabel = action === 'approve' ? 'APPROVED' : 'DENIED';
  const colour      = action === 'approve' ? '#15803d'  : '#b91c1c';
  const icon        = action === 'approve' ? '✓' : '✕';
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f7f8fa;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0"
      style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <tr><td style="background:#1a2744;padding:24px 32px;">
        <span style="font-size:18px;font-weight:700;color:white;">&#9679;&nbsp; ClearDue Legal B.V.</span>
      </td></tr>
      <tr><td style="padding:32px;">
        <div style="background:${colour}18;border:1.5px solid ${colour};border-radius:10px;padding:18px 22px;margin-bottom:24px;">
          <p style="font-size:15px;font-weight:700;color:${colour};margin:0 0 4px;">${icon} Engagement letter ${actionLabel}</p>
          <p style="font-size:13px;color:#374151;margin:0;">
            <strong>${clientName || 'The client'}</strong> has <strong>${actionLabel.toLowerCase()}</strong> the engagement letter.
            ${letterId ? `<br><span style="font-size:11px;color:#9ca3af;">Letter ID: ${letterId}</span>` : ''}
          </p>
        </div>
        <p style="font-size:14px;color:#4a5568;line-height:1.7;margin:0 0 16px;">
          Please log in to the ClearDue portal to review the client's response and update the file accordingly.
        </p>
        <p style="font-size:13px;color:#8a94a6;border-top:1px solid #e2e5ec;padding-top:20px;margin:0;">
          ClearDue Legal B.V. &middot; Herengracht 400, 1017 BX Amsterdam &middot; info@cleardue.legal
        </p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
  try {
    await sendEmail({ to, subject: `${icon} Engagement letter ${actionLabel} — ${clientName} — ClearDue Legal B.V.`, html });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Email] Notify lawyer failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/invite-client ───────────────────────────────────────────────────
app.post('/api/invite-client', async (req, res) => {
  const { to, invitedBy, scopeOfWork } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing recipient email' });
  const appUrl = process.env.APP_URL || 'https://clearduekyc-production.up.railway.app';
  try {
    await sendEmail({ to, subject: 'You have been invited to complete your KYC — ClearDue Legal B.V.', html: inviteEmailHTML(to, invitedBy, appUrl, scopeOfWork) });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Email] Invite failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

function inviteEmailHTML(to, invitedBy, appUrl, scopeOfWork) {
  const scopeBlock = scopeOfWork ? `
        <div style="background:#f8fafc;border:1px solid #e2e5ec;border-radius:10px;padding:18px 20px;margin-bottom:24px;">
          <p style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#8a94a6;margin:0 0 8px;">Proposed scope of work</p>
          <p style="font-size:14px;color:#1a2744;line-height:1.7;margin:0;white-space:pre-wrap;">${scopeOfWork.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>
          <p style="font-size:12px;color:#8a94a6;margin:10px 0 0;">You will be asked to confirm this scope or submit comments when you access the portal.</p>
        </div>` : '';
  // replace function body below — keep original template with scopeBlock injected
  return _inviteEmailHTMLBody(to, invitedBy, appUrl, scopeBlock);
}
function _inviteEmailHTMLBody(to, invitedBy, appUrl, scopeBlock) {
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
        <p style="font-size:14px;color:#4a5568;line-height:1.7;margin:0 0 20px;">
          Click the button below to access the secure portal and complete your file.
          The process takes approximately 5 minutes.
        </p>
        ${scopeBlock}
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

// ── POST /api/send-committee ──────────────────────────────────────────────────
app.post('/api/send-committee', async (req, res) => {
  const { to, clientName, memo, referredBy } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing recipient email' });
  try {
    await sendEmail({ to, subject: `[COMMITTEE REFERRAL] ${clientName} — ClearDue Legal B.V.`, html: committeeEmailHTML(clientName, memo, referredBy) });
    res.json({ ok: true });
  } catch (e) {
    console.error('[Email] Committee referral failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

function committeeEmailHTML(clientName, memo, referredBy) {
  const safeMemo = (memo || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f7f8fa;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
  <tr><td align="center">
    <table width="640" cellpadding="0" cellspacing="0"
      style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <tr><td style="background:#1a2744;padding:20px 32px;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td><span style="font-size:18px;font-weight:700;color:white;letter-spacing:-0.3px;">&#9679;&nbsp; ClearDue Legal B.V.</span></td>
            <td align="right"><span style="background:#b91c1c;color:white;font-size:11px;font-weight:700;padding:5px 12px;border-radius:20px;letter-spacing:0.5px;">&#9872; COMMITTEE REFERRAL</span></td>
          </tr>
        </table>
      </td></tr>
      <tr><td style="padding:32px;">
        <div style="background:#fff1f0;border:1px solid #fca5a5;border-radius:10px;padding:16px 20px;margin-bottom:24px;">
          <p style="font-size:13px;font-weight:700;color:#b91c1c;margin:0 0 6px;">&#9872; Committee action required — ${clientName}</p>
          <p style="font-size:13px;color:#7f1d1d;line-height:1.6;margin:0;">
            This client requires committee approval before work may commence. Please review the referral
            memorandum below and record your decision. The referring partner must be notified of the outcome.
          </p>
        </div>
        <p style="font-size:14px;color:#4a5568;margin:0 0 6px;">Client: <strong>${clientName}</strong></p>
        <p style="font-size:14px;color:#4a5568;margin:0 0 24px;">Referred by: <strong>${referredBy || 'ClearDue Legal'}</strong></p>
        <div style="background:#0f172a;border-radius:10px;padding:28px;margin-bottom:24px;">
          <pre style="font-family:'Courier New',monospace;font-size:12px;color:#e2e8f0;line-height:1.75;margin:0;white-space:pre-wrap;word-break:break-word;">${safeMemo}</pre>
        </div>
        <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px 18px;margin-bottom:24px;">
          <p style="font-size:13px;font-weight:700;color:#166534;margin:0 0 4px;">Next step</p>
          <p style="font-size:13px;color:#14532d;margin:0;">Reply to this email with your committee decision. Work may only commence after written approval has been recorded.</p>
        </div>
        <p style="font-size:12px;color:#8a94a6;border-top:1px solid #e2e5ec;padding-top:20px;margin:0;">
          ClearDue Legal B.V. &middot; Herengracht 400, 1017 BX Amsterdam &middot; info@cleardue.legal<br>
          <strong>This is a strictly confidential internal document. Not for external distribution.</strong>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

// ── POST /api/check-sanctions ─────────────────────────────────────────────────
// Accepts { names: ['string', ...] } — array of names to check (client name, UBOs, etc.)
// Returns { hits: [{ name, matches }] } for any name that hits the sanctions list
app.post('/api/check-sanctions', (req, res) => {
  const { names } = req.body;
  if (!Array.isArray(names)) return res.status(400).json({ error: 'names must be an array' });
  const hits = [];
  for (const name of names) {
    if (!name || typeof name !== 'string') continue;
    const matches = checkSanctions(name.trim());
    if (matches.length) {
      hits.push({ name: name.trim(), matches: matches.slice(0, 3) });
    }
  }
  res.json({ hits, checked: names.length, listSize: _sanctionsNames?.length || 0 });
});

// ── Catch-all → SPA ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'kyc_portal.html'));
});

app.listen(PORT, () => {
  console.log(`ClearDue KYC Portal running on port ${PORT}`);
});
