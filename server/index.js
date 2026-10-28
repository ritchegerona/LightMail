require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const { encrypt } = require('./encryption');
const db = require('./db');
const { fetchEmails, downloadAttachmentStream } = require('./imap');
const { sendEmail } = require('./smtp');

const app = express();
const PORT = process.env.PORT || 3000;
// Local-only client: never expose mail credentials to the network unless asked
const HOST = process.env.HOST || '127.0.0.1';

// ── Security Headers ──
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; " +
    "frame-ancestors 'none'; base-uri 'self'"
  );
  next();
});

// ── Simple in-memory rate limiter ──────────────────────────────────────
// Limits each IP to `max` requests per `windowMs`. Sufficient for a
// local-first client; production would use a shared store.
const rateLimitStore = new Map();
const RATE_LIMIT_MAX = 300;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function rateLimit(max = RATE_LIMIT_MAX, windowMs = RATE_LIMIT_WINDOW_MS) {
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const bucket = rateLimitStore.get(key) || { count: 0, reset: now + windowMs };
    if (now > bucket.reset) {
      bucket.count = 0;
      bucket.reset = now + windowMs;
    }
    bucket.count++;
    rateLimitStore.set(key, bucket);
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - bucket.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(bucket.reset / 1000));
    if (bucket.count > max) {
      return res.status(429).json({ error: 'Too many requests' });
    }
    next();
  };
}
// Apply to API routes only
app.use('/api/', rateLimit());

// ── CSRF Protection ────────────────────────────────────────────────────
// Double-submit cookie pattern. SPA reads the token from the cookie and
// echoes it back in the X-CSRF-Token header for state-changing requests.
const CSRF_COOKIE = 'lightmail_csrf';

function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Minimal cookie parser (avoids adding cookie-parser dependency)
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(';')) {
      const eq = part.indexOf('=');
      if (eq > -1) {
        const name = part.slice(0, eq).trim();
        const val = part.slice(eq + 1).trim();
        if (name) cookies[name] = decodeURIComponent(val);
      }
    }
  }
  return cookies;
}

function setCsrfCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production';
  const parts = [
    `${CSRF_COOKIE}=${token}`,
    'Path=/',
    'SameSite=Strict',
    'Max-Age=86400',
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function csrfProtection(req, res, next) {
  if (process.env.NODE_ENV === 'test') return next();
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const cookies = parseCookies(req);
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF token mismatch' });
  }
  next();
}

// ── Input validation helpers ───────────────────────────────────────────
function validateEmail(val) {
  if (typeof val !== 'string' || val.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(val);
}

// Accepts single or comma-separated recipients, plain ("a@b.c") or
// display-name form ("Chie <chie@msr.ph>"). Rejects control characters
// (header injection) and clearly malformed addresses.
function validateRecipients(val, maxLen = 1024) {
  if (val === undefined || val === null || val === '') return true;
  if (typeof val !== 'string' || val.length > maxLen) return false;
  if (/[\r\n]/.test(val)) return false;
  const parts = val.split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return false;
  for (const p of parts) {
    const m = p.match(/<([^>]+)>$/);
    const addr = m ? m[1] : p;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) return false;
  }
  return true;
}

function validatePort(val) {
  const n = parseInt(val, 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function validateHostname(val) {
  if (typeof val !== 'string' || val.length > 253) return false;
  return /^[a-zA-Z0-9.-]+$/.test(val);
}

function sanitizeString(val, maxLength = 1000) {
  if (val === undefined || val === null) return '';
  if (typeof val !== 'string') return String(val).slice(0, maxLength);
  return val.slice(0, maxLength);
}

function validateAccountId(id) {
  const n = parseInt(id, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function validateEmailId(id) {
  const n = parseInt(id, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── CSRF token endpoint for SPA to fetch ──
app.get('/api/csrf-token', (req, res) => {
  const token = generateCsrfToken();
  setCsrfCookie(res, token);
  res.json({ csrfToken: token });
});

// ── Apply CSRF protection to all state-changing API requests ──
app.use('/api/', csrfProtection);

// ── Uploads (attachments to send) ──
const UPLOAD_DIR = path.join(os.tmpdir(), 'lightmail-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25MB total per request

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, file, cb) => cb(null, Date.now() + '-' + Math.random().toString(36).slice(2, 10) + '-' + path.basename(file.originalname)),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 10 },
});

// Sweep stale uploads older than 1h at startup
function sweepUploads() {
  try {
    const cutoff = Date.now() - 3600 * 1000;
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const p = path.join(UPLOAD_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (_) {}
    }
  } catch (_) {}
}

function unlinkQuiet(p) { try { fs.unlinkSync(p); } catch (_) {} }

// Guard against path traversal — attachment paths must live in UPLOAD_DIR
function safeUploadPath(p) {
  if (!p) return null;
  const resolved = path.resolve(p);
  return resolved.startsWith(UPLOAD_DIR + path.sep) ? resolved : null;
}

async function backgroundSync(accountId, label) {
  if (process.env.NODE_ENV === 'test') return;
  setTimeout(async () => {
    try {
      const acc = await db.getAccount(accountId);
      if (!acc) return;
      await fetchEmails(acc);
      console.log(`✅ ${label} for ${acc.email}`);
    } catch (e) {
      console.error(`❌ ${label} failed:`, e.message);
    }
  }, 100);
}

// ── Account APIs ──
app.post('/api/accounts', async (req, res) => {
  const { email, password, imap_host, imap_port, smtp_host, smtp_port } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  if (!validateEmail(email)) return res.status(400).json({ error: 'Invalid email format' });
  if (typeof password !== 'string' || password.length < 1 || password.length > 256) {
    return res.status(400).json({ error: 'Invalid password' });
  }
  if (imap_host && !validateHostname(imap_host)) return res.status(400).json({ error: 'Invalid IMAP host' });
  if (smtp_host && !validateHostname(smtp_host)) return res.status(400).json({ error: 'Invalid SMTP host' });
  if (imap_port && !validatePort(imap_port)) return res.status(400).json({ error: 'Invalid IMAP port' });
  if (smtp_port && !validatePort(smtp_port)) return res.status(400).json({ error: 'Invalid SMTP port' });

  try {
    const existing = await db.getAccountByEmail(email);
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'Account already exists',
        id: existing.id,
        email: existing.email
      });
    }

    const enc = encrypt(password);
    const id = await db.addAccount(email, enc, imap_host, parseInt(imap_port, 10), smtp_host, parseInt(smtp_port, 10));
    await backgroundSync(id, 'Initial sync');
    res.json({ success: true, id });
  } catch (err) {
    console.error('Error adding account:', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/accounts', async (req, res) => {
  res.json(await db.getAccounts());
});

app.delete('/api/accounts/:id', async (req, res) => {
  const accountId = validateAccountId(req.params.id);
  if (!accountId) return res.status(400).json({ error: 'Invalid account ID' });
  await db.deleteAccount(accountId);
  res.json({ success: true });
});

app.patch('/api/accounts/:id/password', async (req, res) => {
  const accountId = validateAccountId(req.params.id);
  if (!accountId) return res.status(400).json({ error: 'Invalid account ID' });
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (typeof password !== 'string' || password.length < 1 || password.length > 256) {
    return res.status(400).json({ error: 'Invalid password' });
  }
  try {
    const account = await db.getAccount(accountId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    await db.updateAccountPassword(accountId, encrypt(password));
    await backgroundSync(account.id, 'Re-sync after password update');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accurate unread counts per mailbox + starred total
app.get('/api/accounts/:id/unread', async (req, res) => {
  const accountId = validateAccountId(req.params.id);
  if (!accountId) return res.status(400).json({ error: 'Invalid account ID' });
  try {
    res.json(await db.getUnreadCounts(accountId));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id/trash', async (req, res) => {
  const accountId = validateAccountId(req.params.id);
  if (!accountId) return res.status(400).json({ error: 'Invalid account ID' });
  try {
    const changes = await db.purgeTrash(accountId);
    res.json({ success: true, purged: changes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Emails ──
app.get('/api/emails', async (req, res) => {
  const { account_id, mailbox = 'INBOX', limit = 50, offset = 0, q } = req.query;
  if (!account_id) return res.status(400).json({ error: 'account_id required' });
  const aid = validateAccountId(account_id);
  if (!aid) return res.status(400).json({ error: 'Invalid account_id' });
  const lim = Math.min(parseInt(limit, 10) || 50, 200);
  if (isNaN(lim) || lim < 1) return res.status(400).json({ error: 'Invalid limit' });
  const off = Math.max(parseInt(offset, 10) || 0, 0);
  if (isNaN(off)) return res.status(400).json({ error: 'Invalid offset' });
  const sanitizedMailbox = sanitizeString(mailbox, 50);
  const sanitizedQ = sanitizeString(q, 200);
  let emails;
  if (sanitizedQ) {
    emails = await db.searchEmails(aid, sanitizedQ, lim, off);
  } else if (sanitizedMailbox === 'STARRED') {
    emails = await db.getStarred(aid, lim, off);
  } else if (sanitizedMailbox === 'TRASH') {
    emails = await db.getTrashed(aid, lim, off);
  } else {
    emails = await db.getEmails(aid, sanitizedMailbox, lim, off);
  }
  res.json(emails);
});

app.get('/api/emails/:id', async (req, res) => {
  const emailId = validateEmailId(req.params.id);
  if (!emailId) return res.status(400).json({ error: 'Invalid email ID' });
  const email = await db.getEmail(emailId);
  if (!email) return res.status(404).json({ error: 'Not found' });
  res.json(email);
});

app.patch('/api/emails/:id/read', async (req, res) => {
  const emailId = validateEmailId(req.params.id);
  if (!emailId) return res.status(400).json({ error: 'Invalid email ID' });
  const { is_read } = req.body;
  await db.markRead(emailId, is_read);
  res.json({ success: true });
});

app.patch('/api/emails/:id/flag', async (req, res) => {
  const emailId = validateEmailId(req.params.id);
  if (!emailId) return res.status(400).json({ error: 'Invalid email ID' });
  const { is_flagged } = req.body;
  const flagged = !!is_flagged;
  await db.markFlagged(emailId, flagged);
  res.json({ success: true, is_flagged: flagged });
});

app.patch('/api/emails/:id/delete', async (req, res) => {
  const emailId = validateEmailId(req.params.id);
  if (!emailId) return res.status(400).json({ error: 'Invalid email ID' });
  const { is_deleted } = req.body;
  await db.markDeleted(emailId, is_deleted);
  res.json({ success: true });
});

// ── Label APIs ──
app.get('/api/emails/:id/labels', async (req, res) => {
  const emailId = validateEmailId(req.params.id);
  if (!emailId) return res.status(400).json({ error: 'Invalid email ID' });
  try {
    const labels = await db.getEmailLabels(emailId);
    res.json({ labels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/emails/:id/labels', async (req, res) => {
  const emailId = validateEmailId(req.params.id);
  if (!emailId) return res.status(400).json({ error: 'Invalid email ID' });
  const { labels } = req.body;
  if (typeof labels !== 'string') return res.status(400).json({ error: 'Labels must be a string' });
  try {
    const account = await db.getAccount(emailId);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    await db.setLabels(emailId, account.id, labels);
    res.json({ success: true, labels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/accounts/:id/labels', async (req, res) => {
  const accountId = validateAccountId(req.params.id);
  if (!accountId) return res.status(400).json({ error: 'Invalid account ID' });
  try {
    const emails = await db.getEmails(accountId);
    const allLabels = new Set();
    for (const email of emails) {
      const lbls = await db.getEmailLabels(email.id);
      if (lbls) {
        lbls.split(',').forEach(l => { if (l.trim()) allLabels.add(l.trim()); });
      }
    }
    res.json({ labels: Array.from(allLabels).sort() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/accounts/:id/labels', async (req, res) => {
  const accountId = validateAccountId(req.params.id);
  if (!accountId) return res.status(400).json({ error: 'Invalid account ID' });
  const { labels } = req.body;
  if (typeof labels !== 'string') return res.status(400).json({ error: 'Labels must be a string' });
  try {
    await run(
      'UPDATE emails SET labels = ? WHERE account_id = ?',
      [labels, accountId]
    );
    res.json({ success: true, labels });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Permanent delete (single email)
app.delete('/api/emails/:id', async (req, res) => {
  const emailId = validateEmailId(req.params.id);
  if (!emailId) return res.status(400).json({ error: 'Invalid email ID' });
  await db.hardDeleteEmail(emailId);
  res.json({ success: true });
});

// ── Drafts ──
app.post('/api/drafts', async (req, res) => {
  const { account_id, draft_id, to, cc, bcc, subject, body } = req.body;
  if (!account_id) return res.status(400).json({ error: 'account_id required' });
  const aid = validateAccountId(account_id);
  if (!aid) return res.status(400).json({ error: 'Invalid account_id' });
  // Validate recipient fields if provided (single or comma-separated lists)
  if (to && !validateRecipients(to)) return res.status(400).json({ error: 'Invalid "to" recipient' });
  if (cc && !validateRecipients(cc)) return res.status(400).json({ error: 'Invalid "cc" recipient' });
  if (bcc && !validateRecipients(bcc)) return res.status(400).json({ error: 'Invalid "bcc" recipient' });
  try {
    const fields = {
      to_address: sanitizeString(to, 1024),
      cc_address: sanitizeString(cc, 1024),
      bcc_address: sanitizeString(bcc, 1024),
      subject: sanitizeString(subject, 200),
      body_text: sanitizeString(body, 50000),
    };
    let id;
    if (draft_id) {
      const existing = await db.getDraft(draft_id);
      if (!existing || existing.account_id !== aid) {
        return res.status(404).json({ error: 'Draft not found' });
      }
      await db.updateDraft(draft_id, aid, fields);
      id = draft_id;
    } else {
      id = await db.saveDraft(aid, fields);
    }
    res.json({ success: true, draft_id: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Attachments ──
app.get('/api/emails/:id/attachments', async (req, res) => {
  const emailId = validateEmailId(req.params.id);
  if (!emailId) return res.status(400).json({ error: 'Invalid email ID' });
  const email = await db.getEmail(emailId);
  if (!email) return res.status(404).json({ error: 'Email not found' });
  res.json(await db.getAttachments(email.id));
});

app.get('/api/emails/:id/attachments/:attId', async (req, res) => {
  const emailId = validateEmailId(req.params.id);
  const attId = validateEmailId(req.params.attId);
  if (!emailId || !attId) return res.status(400).json({ error: 'Invalid email or attachment ID' });
  try {
    const att = await db.getAttachmentForDownload(attId);
    if (!att || String(att.email_id) !== String(emailId)) {
      return res.status(404).json({ error: 'Attachment not found' });
    }
    const account = await db.getAccount(att.account_id);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const uid = parseInt(String(att.email_message_id).split(':')[1], 10);
    if (!uid || !att.part_id) return res.status(400).json({ error: 'Attachment has no IMAP source' });
    const buf = await downloadAttachmentStream(account, att.mailbox_name, uid, att.part_id);
    res.setHeader('Content-Type', att.mime_type || 'application/octet-stream');
    // Sanitize filename to prevent header injection and path traversal in Content-Disposition
    const safeFilename = (att.filename || 'attachment')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 255);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    res.setHeader('Content-Length', buf.length);
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Upload (files to attach to a send) ──
app.post('/api/upload', (req, res) => {
  upload.array('files', 10)(req, res, (err) => {
    if (err) return res.status(400).json({ error: 'Upload failed' });
    const files = (req.files || []).map(f => ({
      filename: path.basename(f.originalname),
      mimetype: f.mimetype,
      size: f.size,
      path: f.path,
    }));
    res.json({ success: true, files });
  });
});

// ── Send ──
app.post('/api/send', async (req, res) => {
  const { account_id, to, subject, body, cc, bcc, attachments, draft_id } = req.body;
  if (!account_id || !to || !subject) {
    return res.status(400).json({ error: 'account_id, to, subject required' });
  }
  const aid = validateAccountId(account_id);
  if (!aid) return res.status(400).json({ error: 'Invalid account_id' });
  if (!validateRecipients(to)) return res.status(400).json({ error: 'Invalid "to" recipient' });
  if (cc && !validateRecipients(cc)) return res.status(400).json({ error: 'Invalid "cc" recipient' });
  if (bcc && !validateRecipients(bcc)) return res.status(400).json({ error: 'Invalid "bcc" recipient' });
  const sanitizedTo = sanitizeString(to, 1024);
  const sanitizedSubject = sanitizeString(subject, 200);
  const sanitizedBody = sanitizeString(body, 100000);
  const sanitizedCc = sanitizeString(cc, 1024);
  const sanitizedBcc = sanitizeString(bcc, 1024);
  const safeAtts = [];
  if (Array.isArray(attachments)) {
    for (const a of attachments) {
      const p = safeUploadPath(a.path);
      if (!p || !fs.existsSync(p)) continue;
      safeAtts.push({ filename: path.basename(a.filename), contentType: a.mimetype || a.contentType, path: p });
    }
  }
  try {
    const account = await db.getAccount(aid);
    if (!account) return res.status(404).json({ error: 'Account not found' });
    const info = await sendEmail(account, { to: sanitizedTo, cc: sanitizedCc, bcc: sanitizedBcc, subject: sanitizedSubject, body: sanitizedBody, attachments: safeAtts });
    safeAtts.forEach(a => unlinkQuiet(a.path));

    // Ensure the Sent mailbox row exists even before the first successful
    // IMAP sync, so locally sent mail always lands in the Sent folder.
    await db.addMailbox(aid, 'Sent');
    const sentBox = await db.getMailbox(aid, 'Sent');
    if (sentBox) {
      await db.addEmail({
        account_id: aid,
        mailbox_id: sentBox.id,
        message_id: 'local-' + Date.now(),
        rfc_message_id: info.messageId || null,
        from_address: account.email,
        to_address: sanitizedTo,
        cc_address: sanitizedCc,
        bcc_address: sanitizedBcc,
        subject: sanitizedSubject,
        body_text: sanitizedBody,
        body_html: '',
        date_received: Date.now(),
        is_read: 1,
        is_flagged: 0,
        is_deleted: 0,
        thread_id: null,
      });
    }
    if (draft_id) await db.hardDeleteEmail(draft_id).catch(() => {});
    res.json({ success: true, messageId: info.messageId });
  } catch (err) {
    safeAtts.forEach(a => unlinkQuiet(a.path));
    res.status(500).json({ error: err.message });
  }
});

// ── Sync ──
app.post('/api/sync/:accountId', async (req, res) => {
  const accountId = validateAccountId(req.params.accountId);
  if (!accountId) return res.status(400).json({ error: 'Invalid account ID' });
  const account = await db.getAccount(accountId);
  if (!account) return res.status(404).json({ error: 'Account not found' });
  try {
    await fetchEmails(account);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Serve SPA ──
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

if (require.main === module) {
  sweepUploads();

  // ── Auto-sync every 60s ──
  setInterval(async () => {
    const accounts = await db.getAccounts();
    for (const acc of accounts) {
      try {
        await fetchEmails(acc);
      } catch (e) {
        console.warn(`Auto-sync failed for ${acc.email}:`, e.message);
      }
    }
  }, 60000);

  const server = app.listen(PORT, HOST, async () => {
    console.log(`📨 LightMail running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    // initial sync on startup
    setTimeout(async () => {
      const accounts = await db.getAccounts();
      for (const acc of accounts) {
        try {
          await fetchEmails(acc);
          console.log(`✅ Initial sync for ${acc.email} done.`);
        } catch (e) {
          console.error(`❌ Initial sync for ${acc.email} failed:`, e.message);
        }
      }
    }, 1000);
  });
}

module.exports = { app };
