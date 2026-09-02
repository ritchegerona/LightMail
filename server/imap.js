const { ImapFlow } = require('imapflow');
const { decrypt } = require('./encryption');

// One sync per account at a time (prevents duplicate-mailbox races)
const syncing = new Set();

const AUTH_HINTS = [
  ['application-specific', 'This Google account requires an App Password. Generate one at https://myaccount.google.com/apppasswords then click 🔑 next to the account to save it.'],
  ['invalid credentials', 'Login rejected — check the email and password (Gmail requires an App Password: https://myaccount.google.com/apppasswords).'],
  ['authenticationfailed', 'Login rejected — check the email and password (use an App Password for Gmail/Yahoo).'],
  ['login failed', 'Login rejected — check the email and password.'],
  ['badcredentials', 'Login rejected — check the email and password.'],
];

const MAX_TEXT_LEN = 50000;
const MAX_HTML_LEN = 500000;

function friendlyError(err) {
  const raw = (err && (err.response || err.text || err.message)) || 'Unknown error';
  const lower = String(raw).toLowerCase();
  for (const [needle, hint] of AUTH_HINTS) {
    if (lower.includes(needle)) return hint;
  }
  return String(raw);
}

async function openClient(account) {
  let password;
  try {
    password = decrypt(account.encrypted_password);
  } catch (e) {
    throw new Error('Stored password could not be decrypted — click 🔑 next to the account to update it.');
  }
  const client = new ImapFlow({
    host: account.imap_host,
    port: account.imap_port,
    secure: account.imap_port === 993,
    auth: { user: account.email, pass: password },
    logger: false,
    // Verify server certs by default; opt-out only for self-signed servers
    tls: process.env.MAIL_ALLOW_INSECURE_TLS === '1' ? { rejectUnauthorized: false } : {},
  });
  client.on('error', (err) => {
    console.error(`❌ IMAP client error for ${account.email}:`, err.message);
  });
  await client.connect();
  return client;
}

async function closeClient(client) {
  if (!client) return;
  try { await client.logout(); } catch (_) {}
  try { client.close(); } catch (_) {}
}

// Resolve canonical folder paths via special-use flags (Gmail: [Gmail]/Sent Mail etc.)
async function resolveFolderPath(client, canonicalName) {
  const list = await client.list();
  const specialUseMap = { INBOX: '\\Inbox', Sent: '\\Sent', Drafts: '\\Drafts' };
  const bySpecial = list.find(mb => mb.specialUse && mb.specialUse.toLowerCase() === specialUseMap[canonicalName].toLowerCase());
  if (bySpecial) return bySpecial.path;
  const candidates = {
    INBOX: ['inbox'],
    Sent: ['sent', 'sent mail', '[gmail]/sent mail'],
    Drafts: ['drafts', '[gmail]/drafts'],
  }[canonicalName] || [canonicalName.toLowerCase()];
  const byPath = list.find(mb => candidates.some(c => mb.path.toLowerCase() === c));
  return byPath ? byPath.path : null;
}

// ImapFlow returns flags as a Set; be tolerant of arrays too
function hasFlag(flags, flag) {
  if (!flags) return false;
  return typeof flags.has === 'function' ? flags.has(flag) : flags.includes(flag);
}

// Walk an IMAP BODYSTRUCTURE tree and return the part id of the best text leaf
function findTextPart(node) {
  return walkPart(node, 'text/plain');
}
function findHtmlPart(node) {
  return walkPart(node, 'text/html');
}
function walkPart(node, wantedType) {
  if (!node) return null;
  const isMatch = String(node.type || '').toLowerCase() === wantedType;
  const disposition = String(node.disposition || '').toLowerCase();
  if (isMatch && disposition !== 'attachment' && node.part) return node.part;
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) {
      const found = walkPart(child, wantedType);
      if (found) return found;
    }
  }
  return null;
}

// Walk BODYSTRUCTURE and collect downloadable attachment parts
function collectAttachments(node, out = []) {
  if (!node) return out;
  const disposition = String(node.disposition || '').toLowerCase();
  const type = String(node.type || '').toLowerCase();
  const filename = node.filename ||
    (node.dispositionParameters && node.dispositionParameters.filename) ||
    (node.parameters && node.parameters.name) || null;
  const isAttachment = disposition === 'attachment' ||
    (!!filename && type !== 'text/plain' && type !== 'text/html') ||
    (!!filename && disposition === 'attachment');
  if (isAttachment && filename && node.part) {
    out.push({
      part_id: node.part,
      filename,
      mime_type: node.type || 'application/octet-stream',
      size: node.size || null,
    });
  }
  if (Array.isArray(node.childNodes)) {
    for (const child of node.childNodes) collectAttachments(child, out);
  }
  // multipart/* siblings sometimes live in node.childNodes only — covered above
  return out;
}

async function readStream(content, maxLen = Infinity) {
  const chunks = [];
  let total = 0;
  for await (const chunk of content) {
    total += chunk.length;
    chunks.push(chunk);
    if (total >= maxLen + 1024) break; // small overshoot then trim
  }
  const buf = Buffer.concat(chunks);
  return maxLen === Infinity ? buf : buf.subarray(0, maxLen).toString('utf8');
}

async function fetchEmails(account) {
  if (syncing.has(account.id)) return { synced: 0, skipped: true };
  syncing.add(account.id);

  const { getMailbox, addEmail, updateLastSync, addMailbox, replaceAttachmentsForEmail } = require('./db');

  let client;
  try {
    client = await openClient(account);
  } catch (err) {
    syncing.delete(account.id);
    const msg = friendlyError(err);
    console.error(`❌ IMAP sync failed for ${account.email}:`, msg);
    throw new Error(msg);
  }

  try {
    console.log(`🔌 Connected to IMAP for ${account.email}`);

    // --- Resolve folders via special-use flags ---
    const targets = [];
    for (const name of ['INBOX', 'Sent', 'Drafts']) {
      const path = await resolveFolderPath(client, name);
      if (path) targets.push({ name, path });
    }

    // Ensure canonical mailbox rows exist (INSERT OR IGNORE guards races)
    for (const t of targets) {
      const existing = await getMailbox(account.id, t.name);
      if (!existing) {
        await addMailbox(account.id, t.name);
        console.log(`📁 Created mailbox: ${t.name}`);
      }
    }

    // --- Sync INBOX, Sent, Drafts (last 50 each) ---
    let totalSynced = 0;
    for (const target of targets) {
      const { name: boxName, path: boxPath } = target;
      try {
        const mailbox = await getMailbox(account.id, boxName);
        if (!mailbox) {
          console.warn(`⚠️ Mailbox "${boxName}" not found, skipping.`);
          continue;
        }
        // ImapFlow silently yields nothing if no mailbox is selected — must open first
        const opened = await client.mailboxOpen(boxPath);
        // mailboxOpen().messages is unreliable (undefined on Gmail) — use STATUS
        let total = 0;
        try {
          const status = await client.status(boxPath, { messages: true });
          total = (status && status.messages) || 0;
        } catch (e) { /* fall back to uidNext window below */ }

        let range, rangeOpts = {};
        if (total > 0) {
          // Newest 50 by SEQUENCE number (msg.uid still returned via query)
          const start = Math.max(1, total - 49);
          range = `${start}:*`;
        } else {
          // Fallback: window of ~200 UIDs ending at uidNext
          range = `${Math.max(1, (opened.uidNext || 1) - 200)}:*`;
          rangeOpts = { uid: true };
        }

        const messages = [];
        for await (const msg of client.fetch(
          range,
          { uid: true, envelope: true, bodyStructure: true, flags: true, internalDate: true },
          rangeOpts
        )) {
          messages.push(msg);
        }
        messages.sort((a, b) => (b.internalDate?.getTime() || 0) - (a.internalDate?.getTime() || 0));
        const newest = total > 0 ? messages : messages.slice(0, 50);

        for (const msg of newest) {
          const env = msg.envelope || {};
          const from = env.from && env.from[0] ? env.from[0].address : '';
          const to = env.to ? env.to.map(a => a.address).join(', ') : '';
          const cc = env.cc ? env.cc.map(a => a.address).join(', ') : '';
          const subject = env.subject || '(no subject)';
          const date = msg.internalDate
            ? msg.internalDate.getTime()
            : (env.date ? new Date(env.date).getTime() : Date.now());

          // Download text/plain part via the real ImapFlow API
          let bodyText = '';
          let bodyHtml = '';
          const textPartId = findTextPart(msg.bodyStructure);
          if (textPartId) {
            try {
              const { content } = await client.download(msg.uid, textPartId, { uid: true });
              if (content) bodyText = await readStream(content, MAX_TEXT_LEN);
            } catch (e) {
              // body is optional — keep going
            }
          }
          const htmlPartId = findHtmlPart(msg.bodyStructure);
          if (htmlPartId && htmlPartId !== textPartId) {
            try {
              const { content } = await client.download(msg.uid, htmlPartId, { uid: true });
              if (content) bodyHtml = await readStream(content, MAX_HTML_LEN);
            } catch (e) { /* optional */ }
          }

          // Collect attachment metadata from BODYSTRUCTURE
          const atts = collectAttachments(msg.bodyStructure).map(a => ({ ...a, imap_uid: msg.uid }));

          const emailId = await addEmail({
            account_id: account.id,
            mailbox_id: mailbox.id,
            message_id: `${mailbox.id}:${msg.uid}`,
            rfc_message_id: env.messageId || null,
            from_address: from,
            to_address: to,
            cc_address: cc,
            subject,
            body_text: bodyText,
            body_html: bodyHtml,
            date_received: date,
            is_read: hasFlag(msg.flags, '\\Seen') ? 1 : 0,
            is_flagged: hasFlag(msg.flags, '\\Flagged') ? 1 : 0,
            is_deleted: hasFlag(msg.flags, '\\Deleted') ? 1 : 0,
            thread_id: null,
          });

          if (atts.length) await replaceAttachmentsForEmail(emailId, atts);
        }
        totalSynced += newest.length;
        console.log(`✅ Synced ${newest.length} messages from "${boxName}"`);
      } catch (err) {
        console.error(`❌ Error syncing "${boxName}" for ${account.email}:`, err.message);
      }
    }

    updateLastSync(account.id, Date.now()).catch(() => {});
    console.log(`✅ IMAP sync completed for ${account.email}`);
    return { synced: totalSynced };
  } catch (err) {
    const msg = friendlyError(err);
    console.error(`❌ IMAP sync failed for ${account.email}:`, msg);
    throw new Error(msg);
  } finally {
    // Always release the socket — a mid-sync failure must not leak the connection
    await closeClient(client);
    syncing.delete(account.id);
  }
}

/**
 * Stream one attachment part live from the IMAP server.
 * @returns stream to pipe into the HTTP response
 */
async function downloadAttachmentStream(account, mailboxName, uid, partId) {
  const client = await openClient(account);
  try {
    const path = await resolveFolderPath(client, mailboxName);
    if (!path) throw new Error(`Folder "${mailboxName}" not found on server`);
    await client.mailboxOpen(path);
    const { content } = await client.download(uid, partId, { uid: true });
    // Detach the stream so it survives logout — ImapFlow streams are tied to the socket.
    // Read it fully instead; attachments are size-capped by providers (~25MB).
    return await readStream(content); // returns Buffer when no maxLen given
  } finally {
    await closeClient(client);
  }
}

module.exports = { fetchEmails, downloadAttachmentStream };
