const express    = require('express');
const path       = require('path');
const nodemailer = require('nodemailer');
const { Resend } = require('resend');
const fs         = require('fs');
const Anthropic  = require('@anthropic-ai/sdk');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname)));
app.use(express.json({ limit: '2mb' }));

// ── EU Sanctions list — loaded once at startup ────────────────────────────────
let _sanctionsNames = null; // array of normalized strings
let _sanctionsSet   = null; // Set for O(1) exact lookups
const _STOP_WORDS   = new Set(['van','von','den','der','bin','bint','abu','ibn','the','and']);

function loadSanctions() {
  try {
    const raw  = fs.readFileSync(path.join(__dirname, 'sanctions.json'), 'utf8');
    const data = JSON.parse(raw);
    _sanctionsNames = data.names || [];
    _sanctionsSet   = new Set(_sanctionsNames);
    console.log(`[Sanctions] Loaded ${_sanctionsNames.length} entries (${data.source || 'EU list'}, ${data.generated || ''})`);
  } catch(e) {
    console.warn('[Sanctions] Could not load sanctions.json:', e.message);
    _sanctionsNames = [];
    _sanctionsSet   = new Set();
  }
}
loadSanctions();

function normalizeName(s) {
  if (!s) return '';
  s = s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return s.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Fuzzy token-based match: returns matching sanctions entries for a given name
function checkSanctions(name) {
  if (!_sanctionsNames || !_sanctionsNames.length || !name) return [];
  const norm = normalizeName(name);
  if (norm.length < 3) return [];

  // Fast path: exact match via Set
  if (_sanctionsSet.has(norm) && norm.length >= 5) return [norm];

  // Compute significant tokens once (outside the loop)
  const tokens    = norm.split(' ').filter(t => t.length >= 3);
  const sigTokens = tokens.filter(t => t.length >= 4 && !_STOP_WORDS.has(t));

  const matches = [];
  for (const entry of _sanctionsNames) {
    // Substring match
    if (entry.includes(norm) || norm.includes(entry)) {
      const matched = entry.length <= norm.length ? entry : norm;
      if (matched.length >= 5) { matches.push(entry); if (matches.length >= 3) break; continue; }
    }
    // Token match: all significant tokens must appear in the entry
    if (sigTokens.length >= 2 && sigTokens.every(t => entry.includes(t))) {
      matches.push(entry);
      if (matches.length >= 3) break;
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

function engagementLetterEmailHTML(clientName, engData, letterId, lawyerEmail, appUrl) {
  const base       = appUrl || process.env.APP_URL || 'https://clearduekyc-production.up.railway.app';
  const approveUrl = base + '?letter_action=approve&lid=' + encodeURIComponent(letterId||'') + '&lawyer=' + encodeURIComponent(lawyerEmail||'');
  const denyUrl    = base + '?letter_action=deny&lid='    + encodeURIComponent(letterId||'') + '&lawyer=' + encodeURIComponent(lawyerEmail||'');

  const { scope, timeline, feeStr, disbursements, team } = engData || {};
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const teamList = Array.isArray(team) && team.length
    ? team.map(m => `${m.name}${m.role ? ' \u2014 ' + m.role : ''}${m.rate ? ' (\u20ac' + m.rate + '/hr)' : ''}`).join('\n   ')
    : 'To be confirmed';

  const memo = [
    'ENGAGEMENT CONFIRMATION',
    'ClearDue Legal B.V.',
    '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    '',
    'Client:         ' + (clientName || 'Client'),
    'Scope of work:  ' + (scope || 'To be confirmed'),
    'Timeline:       ' + (timeline || 'To be agreed'),
    'Fee arrangement:' + (feeStr || 'To be agreed'),
    'Disbursements:  ' + (disbursements || 'Included in fee'),
    'Team:           ' + teamList,
    '',
    '\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
    'GENERAL TERMS AND CONDITIONS (sample)',
    '',
    '1. SERVICES',
    '   Legal services as described above, rendered with professional',
    '   care per Dutch law and NOvA rules.',
    '',
    '2. FEES & INVOICING',
    '   Fees exclusive of VAT (21%). Invoices payable within 14 days.',
    '   Statutory interest accrues on overdue amounts (Art. 6:119a DCC).',
    '',
    '3. LIABILITY',
    '   Limited to professional indemnity insurance payout, and in any',
    '   event not exceeding fees invoiced in the preceding three months.',
    '',
    '4. CONFIDENTIALITY',
    '   All client information is strictly confidential. No disclosure',
    '   without prior written consent, except as required by law (Wwft).',
    '',
    '5. GOVERNING LAW',
    '   Dutch law applies. Disputes: courts of Amsterdam.',
    '',
    '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
    'Sample terms only. Full Algemene Voorwaarden provided on engagement.',
  ].join('\n');

  const safeMemo = esc(memo);

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
        <p style="font-size:15px;font-weight:600;color:#0e1624;margin:0 0 8px;">Engagement confirmation — action required</p>
        <p style="font-size:14px;color:#4a5568;line-height:1.7;margin:0 0 20px;">
          Dear ${esc(clientName) || 'Client'},<br><br>
          Please review the engagement details below and accept or decline.
          All our services are subject to our general terms and conditions (included below).
          Work may only commence after KYC is complete and this confirmation is accepted.
        </p>
        <div style="background:#0f172a;border-radius:10px;padding:28px;margin-bottom:24px;">
          <pre style="font-family:'Courier New',monospace;font-size:12px;color:#e2e8f0;line-height:1.75;margin:0;white-space:pre-wrap;word-break:break-word;">${safeMemo}</pre>
        </div>
        <div style="text-align:center;margin:0 0 28px;">
          <a href="${approveUrl}" style="display:inline-block;background:#15803d;color:white;text-decoration:none;padding:13px 32px;border-radius:10px;font-size:14px;font-weight:600;margin:6px;">&#10003; Accept</a>
          <a href="${denyUrl}" style="display:inline-block;background:#b91c1c;color:white;text-decoration:none;padding:13px 32px;border-radius:10px;font-size:14px;font-weight:600;margin:6px;">&#10005; Decline</a>
        </div>
        <p style="font-size:12px;color:#8a94a6;border-top:1px solid #e2e5ec;padding-top:20px;margin:0;">
          ClearDue Legal B.V. &middot; Herengracht 400, 1017 BX Amsterdam &middot; info@cleardue.legal
        </p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
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
  const { to, clientName, engagementData, letterId, lawyerEmail } = req.body;
  if (!to) return res.status(400).json({ error: 'Missing recipient email' });
  const appUrl = process.env.APP_URL || 'https://clearduekyc-production.up.railway.app';
  try {
    await sendEmail({ to, subject: 'Engagement confirmation — ClearDue Legal B.V.', html: engagementLetterEmailHTML(clientName, engagementData || {}, letterId, lawyerEmail, appUrl) });
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

// ── POST /api/send-questions ──────────────────────────────────────────────────
app.post('/api/send-questions', async (req, res) => {
  const { to, clientName, questions, lawyerEmail } = req.body;
  if (!to)                         return res.status(400).json({ error: 'Missing recipient email' });
  if (!Array.isArray(questions) || !questions.length) return res.status(400).json({ error: 'No questions provided' });

  const questionRows = questions.map((q, i) =>
    `<tr><td style="padding:10px 14px;border-bottom:1px solid #e2e5ec;vertical-align:top;font-size:13px;color:#374151;font-weight:600;">${i+1}.</td>
     <td style="padding:10px 14px;border-bottom:1px solid #e2e5ec;font-size:13px;color:#374151;line-height:1.6;">${q.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</td></tr>`
  ).join('');

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f7f8fa;font-family:'Helvetica Neue',Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 16px;">
  <tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0"
      style="background:white;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <tr><td style="background:#1a2744;padding:24px 32px;">
        <span style="font-size:18px;font-weight:700;color:white;letter-spacing:-0.3px;">&#9679;&nbsp; ClearDue Legal B.V.</span>
      </td></tr>
      <tr><td style="padding:32px;">
        <p style="font-size:15px;font-weight:600;color:#0e1624;margin:0 0 16px;">Additional information required</p>
        <p style="font-size:14px;color:#4a5568;line-height:1.7;margin:0 0 20px;">
          Dear ${clientName || 'Client'},<br><br>
          As part of our client due diligence process under the Wwft, we require some additional
          information from you. Please reply to this email with your answers to the questions below.
        </p>
        <table width="100%" cellpadding="0" cellspacing="0"
          style="border:1px solid #e2e5ec;border-radius:10px;overflow:hidden;margin-bottom:24px;">
          ${questionRows}
        </table>
        <div style="background:#f0f7ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px 18px;margin-bottom:24px;">
          <p style="font-size:13px;color:#1e40af;font-weight:600;margin:0 0 4px;">How to respond</p>
          <p style="font-size:13px;color:#1e3a8a;margin:0;">Please reply directly to this email with your answers. You may also contact us at info@cleardue.legal.</p>
        </div>
        <p style="font-size:13px;color:#8a94a6;border-top:1px solid #e2e5ec;padding-top:20px;margin:0;">
          ClearDue Legal B.V. &middot; Herengracht 400, 1017 BX Amsterdam &middot; info@cleardue.legal<br>
          ${lawyerEmail ? `This request was sent by ${lawyerEmail}.` : ''}
        </p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  try {
    await sendEmail({ to, subject: 'Additional information required for your KYC file — ClearDue Legal B.V.', html });
    res.json({ ok: true });
  } catch(e) {
    console.error('[Email] Send questions failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/risk-assessment ─────────────────────────────────────────────────
app.post('/api/risk-assessment', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured in Railway Variables.' });
  }
  const { submission } = req.body;
  if (!submission) return res.status(400).json({ error: 'Missing submission data.' });

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `Wwft/FATF KYC risk assessor for a Dutch law firm. Respond ONLY with a JSON object — no prose, no markdown, no code fences. Start with { end with }.

JSON structure (no extra fields, no deviations):
{"overallRisk":"high|medium|low","riskJustification":"max 1 sentence","cddLevel":"enhanced|standard|simplified","riskFactors":[{"factor":"max 5 words","severity":"high|medium|low","explanation":"max 1 sentence","legalBasis":"Art. X Wwft or FATF R.X"}],"suggestedQuestions":[{"question":"max 15 words","rationale":"max 1 sentence"}],"suggestedDocuments":[{"document":"max 6 words","rationale":"max 1 sentence"}],"ongoingMonitoring":"max 1 sentence","disclaimer":"AI-generated, not legal advice."}

HARD LIMITS: riskFactors=4 items, suggestedQuestions=3 items, suggestedDocuments=2 items. Every string field: 1 sentence maximum. Violating these limits breaks the system.`;

  const fd  = submission.formData || {};
  const docsUploaded = Object.keys(submission.docs || {}).join(', ') || 'none';
  const userPrompt = `KYC FILE:
type=${submission.clientType||'?'} name="${submission.clientName||'?'}" country="${fd.country||fd.incCountry||'?'}" nationality="${fd.nationality||'?'}" pep=${fd.pep||'?'} ubo="${submission.uboName||fd.ubo1||'?'}" legalForm="${fd.legalForm||'?'}" scope="${(submission.scopeOfWork||submission.service||'?').substring(0,200)}" risk=${submission.risk||'?'} docs="${docsUploaded}"
Return JSON now.`;

  try {
    const message = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      system:     systemPrompt,
      messages:   [{ role: 'user', content: userPrompt }],
    });

    const raw        = message.content[0]?.text || '';
    const stopReason = message.stop_reason;
    if (stopReason === 'max_tokens') {
      console.error('[RiskAssessment] Response truncated');
      return res.status(500).json({ error: 'Assessment was too long to complete — please try again.' });
    }
    const start = raw.indexOf('{');
    const end   = raw.lastIndexOf('}');
    if (start === -1 || end === -1) {
      console.error('[RiskAssessment] No JSON found in response:', raw.substring(0, 200));
      return res.status(500).json({ error: 'AI did not return a valid assessment — please try again.' });
    }
    const assessment = JSON.parse(raw.slice(start, end + 1));
    res.json({ assessment });
  } catch(e) {
    console.error('[RiskAssessment] Error:', e.message);
    res.status(500).json({ error: 'Assessment failed: ' + e.message });
  }
});

// ── Catch-all → SPA ──────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'kyc_portal.html'));
});

app.listen(PORT, () => {
  console.log(`ClearDue KYC Portal running on port ${PORT}`);
});
