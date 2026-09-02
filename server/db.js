const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../data/mail.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new sqlite3.Database(DB_PATH);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function initSchema() {
  const sql = `
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      encrypted_password TEXT NOT NULL,
      imap_host TEXT NOT NULL,
      imap_port INTEGER NOT NULL,
      smtp_host TEXT NOT NULL,
      smtp_port INTEGER NOT NULL,
      last_sync_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS mailboxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      mailbox_id INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      from_address TEXT,
      to_address TEXT,
      cc_address TEXT,
      subject TEXT,
      body_text TEXT,
      body_html TEXT,
      date_received INTEGER,
      is_read BOOLEAN DEFAULT 0,
      is_flagged BOOLEAN DEFAULT 0,
      is_deleted BOOLEAN DEFAULT 0,
      thread_id TEXT,
      FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE,
      FOREIGN KEY(mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_emails_account_msg ON emails(account_id, message_id);
    CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_id INTEGER NOT NULL,
      filename TEXT,
      file_path TEXT,
      mime_type TEXT,
      size INTEGER,
      FOREIGN KEY(email_id) REFERENCES emails(id) ON DELETE CASCADE
    );
    -- FTS5 removed: search uses LIKE, and the external-content triggers
    -- corrupted the index on upsert (stale tokens). Drop legacy objects.
    DROP TRIGGER IF EXISTS emails_after_insert;
    DROP TRIGGER IF EXISTS emails_after_update;
    DROP TRIGGER IF EXISTS emails_after_delete;
    DROP TABLE IF EXISTS emails_fts;
  `;

  db.exec(sql, (err) => {
    if (err) console.error('Schema init error', err);
  });

  // ── Migration: collapse duplicate mailboxes (pre-race-condition artifacts) ──
  db.serialize(() => {
    db.run(`
      UPDATE emails
      SET mailbox_id = (
        SELECT MIN(m2.id) FROM mailboxes m2
        JOIN mailboxes m ON m.account_id = m2.account_id AND m.name = m2.name
        WHERE m.id = emails.mailbox_id
      )
      WHERE mailbox_id IN (
        SELECT m.id FROM mailboxes m
        WHERE m.id > (SELECT MIN(m3.id) FROM mailboxes m3 WHERE m3.account_id = m.account_id AND m3.name = m.name)
      )
    `, (e) => { if (e) console.error('Migration re-point failed:', e.message); });
    db.run("DELETE FROM mailboxes WHERE name NOT IN ('INBOX', 'Sent', 'Drafts')",
      (e) => { if (e) console.error('Migration cleanup failed:', e.message); });
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_mailboxes_account_name ON mailboxes(account_id, name)',
      (e) => { if (e) console.error('Mailbox unique index failed:', e.message); });
    // ── Migrations: additive columns.
    // Enqueued SYNCHRONOUSLY here so sqlite's FIFO queue guarantees they run
    // before any later request-time query. Duplicate-column errors are normal
    // on second boot and silently ignored.
    const ensureColumn = (table, ddl) => {
      db.run(`ALTER TABLE ${table} ADD COLUMN ${ddl}`, () => {});
    };
    ensureColumn('emails', 'rfc_message_id TEXT');
    ensureColumn('emails', 'is_draft INTEGER DEFAULT 0');
    ensureColumn('emails', 'bcc_address TEXT');
    ensureColumn('attachments', 'part_id TEXT');
    ensureColumn('attachments', 'imap_uid INTEGER');

    // Indexes are idempotent and also FIFO-ordered after the ALTERs above
    db.run('CREATE INDEX IF NOT EXISTS idx_emails_account_rfc ON emails(account_id, rfc_message_id)',
      (e) => { if (e) console.error('RFC id index failed:', e.message); });
    db.run('CREATE INDEX IF NOT EXISTS idx_emails_account_flag ON emails(account_id, is_flagged, is_deleted)',
      (e) => { if (e) console.error('Flag index failed:', e.message); });
    db.run('CREATE INDEX IF NOT EXISTS idx_attachments_email ON attachments(email_id)',
      (e) => { if (e) console.error('Attachment index failed:', e.message); });
  });
}
initSchema();

async function addAccount(email, encryptedPassword, imapHost, imapPort, smtpHost, smtpPort) {
  const result = await run(
    `INSERT INTO accounts (email, encrypted_password, imap_host, imap_port, smtp_host, smtp_port, last_sync_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [email, encryptedPassword, imapHost, imapPort, smtpHost, smtpPort, Date.now()]
  );
  return result.lastID;
}

async function getAccounts() {
  return all('SELECT * FROM accounts ORDER BY id');
}

async function getAccount(id) {
  return get('SELECT * FROM accounts WHERE id = ?', [id]);
}

async function deleteAccount(id) {
  await run('DELETE FROM accounts WHERE id = ?', [id]);
}

async function updateAccountPassword(id, encryptedPassword) {
  await run('UPDATE accounts SET encrypted_password = ? WHERE id = ?', [encryptedPassword, id]);
}

async function updateLastSync(accountId, timestamp) {
  await run('UPDATE accounts SET last_sync_at = ? WHERE id = ?', [timestamp, accountId]);
}

async function addMailbox(accountId, name) {
  await run('INSERT OR IGNORE INTO mailboxes (account_id, name) VALUES (?, ?)', [accountId, name]);
}

async function getMailboxes(accountId) {
  return all('SELECT * FROM mailboxes WHERE account_id = ?', [accountId]);
}

async function getMailbox(accountId, name) {
  return get('SELECT * FROM mailboxes WHERE account_id = ? AND name = ?', [accountId, name]);
}

async function addEmail(email) {
  // Dedup: a locally-stored sent copy ('local-*' message_id) is repointed to the
  // synced server copy instead of inserting a visible duplicate.
  const rfcId = email.rfc_message_id || null;
  if (rfcId) {
    const existing = await get(
      'SELECT id FROM emails WHERE account_id = ? AND rfc_message_id = ? LIMIT 1',
      [email.account_id, rfcId]
    );
    if (existing) {
      await run(`
        UPDATE emails SET
          mailbox_id = ?, message_id = ?, from_address = ?, to_address = ?, cc_address = ?,
          subject = ?, body_text = ?, body_html = ?, date_received = ?,
          is_read = ?, is_flagged = ?, is_deleted = ?
        WHERE id = ?
      `, [
        email.mailbox_id,
        email.message_id,
        email.from_address,
        email.to_address,
        email.cc_address,
        email.subject,
        email.body_text,
        email.body_html,
        email.date_received,
        email.is_read ? 1 : 0,
        email.is_flagged ? 1 : 0,
        email.is_deleted ? 1 : 0,
        existing.id
      ]);
      return existing.id;
    }
  }

  // Same (account_id, message_id) already stored? Update it and return its
  // real id. (ON CONFLICT..DO UPDATE leaves lastID pointing at an arbitrary
  // earlier insert, which broke attachment linking and could dangle after
  // deletions → FOREIGN KEY constraint failed during Sent/Drafts sync.)
  const byMsg = await get(
    'SELECT id FROM emails WHERE account_id = ? AND message_id = ? LIMIT 1',
    [email.account_id, email.message_id]
  );
  if (byMsg) {
    await run(`
      UPDATE emails SET
        mailbox_id = ?, is_read = ?, is_flagged = ?, is_deleted = ?,
        subject = ?, body_text = ?, body_html = ?
      WHERE id = ?
    `, [
      email.mailbox_id,
      email.is_read ? 1 : 0,
      email.is_flagged ? 1 : 0,
      email.is_deleted ? 1 : 0,
      email.subject,
      email.body_text,
      email.body_html,
      byMsg.id
    ]);
    return byMsg.id;
  }

  const result = await run(`
    INSERT INTO emails
      (account_id, mailbox_id, message_id, rfc_message_id, from_address, to_address, cc_address, bcc_address,
       subject, body_text, body_html, date_received, is_read, is_flagged, is_deleted, thread_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    email.account_id,
    email.mailbox_id,
    email.message_id,
    rfcId,
    email.from_address,
    email.to_address,
    email.cc_address,
    email.bcc_address || null,
    email.subject,
    email.body_text,
    email.body_html,
    email.date_received,
    email.is_read ? 1 : 0,
    email.is_flagged ? 1 : 0,
    email.is_deleted ? 1 : 0,
    email.thread_id || null
  ]);
  return result.lastID;
}

// Shared SELECT for list views — includes attachment indicator
const LIST_SELECT = `
  SELECT e.*, m.name as mailbox_name,
    (SELECT COUNT(*) FROM attachments a WHERE a.email_id = e.id) AS has_attachments
  FROM emails e
  JOIN mailboxes m ON e.mailbox_id = m.id
`;

async function getEmails(accountId, mailboxName, limit = 50, offset = 0) {
  let query = LIST_SELECT + ' WHERE e.account_id = ? AND e.is_deleted = 0';
  const params = [accountId];
  if (mailboxName) {
    query += ' AND m.name = ?';
    params.push(mailboxName);
  }
  query += ' ORDER BY e.date_received DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);
  return all(query, params);
}

async function getStarred(accountId, limit = 50, offset = 0) {
  return all(LIST_SELECT + `
    WHERE e.account_id = ? AND e.is_flagged = 1 AND e.is_deleted = 0
    ORDER BY e.date_received DESC LIMIT ? OFFSET ?
  `, [accountId, limit, offset]);
}

async function getTrashed(accountId, limit = 50, offset = 0) {
  return all(LIST_SELECT + `
    WHERE e.account_id = ? AND e.is_deleted = 1
    ORDER BY e.date_received DESC LIMIT ? OFFSET ?
  `, [accountId, limit, offset]);
}

async function getEmail(id) {
  return get(`
    SELECT e.*, m.name as mailbox_name,
      (SELECT COUNT(*) FROM attachments a WHERE a.email_id = e.id) AS has_attachments
    FROM emails e
    JOIN mailboxes m ON e.mailbox_id = m.id
    WHERE e.id = ?
  `, [id]);
}

async function markRead(id, isRead) {
  await run('UPDATE emails SET is_read = ? WHERE id = ?', [isRead ? 1 : 0, id]);
}

async function markFlagged(id, isFlagged) {
  await run('UPDATE emails SET is_flagged = ? WHERE id = ?', [isFlagged ? 1 : 0, id]);
}

async function hardDeleteEmail(id) {
  await run('DELETE FROM emails WHERE id = ?', [id]);
}

async function purgeTrash(accountId) {
  const result = await run('DELETE FROM emails WHERE account_id = ? AND is_deleted = 1', [accountId]);
  return result.changes;
}

// Accurate unread counts per mailbox (not limited to the visible page)
async function getUnreadCounts(accountId) {
  const rows = await all(`
    SELECT m.name, COUNT(*) as count
    FROM emails e
    JOIN mailboxes m ON e.mailbox_id = m.id
    WHERE e.account_id = ? AND e.is_read = 0 AND e.is_deleted = 0
    GROUP BY m.name
  `, [accountId]);
  const counts = { INBOX: 0, Sent: 0, Drafts: 0 };
  for (const r of rows) counts[r.name] = r.count;
  const starred = await get(`
    SELECT COUNT(*) as count FROM emails
    WHERE account_id = ? AND is_flagged = 1 AND is_deleted = 0
  `, [accountId]);
  counts.STARRED = starred ? starred.count : 0;
  return counts;
}

// ── Drafts ──
async function saveDraft(accountId, { to_address = '', cc_address = '', bcc_address = '', subject = '', body_text = '' }) {
  await addMailbox(accountId, 'Drafts'); // ensure row exists even before first sync
  const draftsBox = await getMailbox(accountId, 'Drafts');
  if (!draftsBox) throw new Error('Could not create Drafts mailbox');
  const acc = await getAccount(accountId);
  const result = await run(`
    INSERT INTO emails
      (account_id, mailbox_id, message_id, from_address, to_address, cc_address, bcc_address,
       subject, body_text, date_received, is_read, is_flagged, is_deleted, is_draft)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 1)
  `, [accountId, draftsBox.id, 'draft-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      acc ? acc.email : '', to_address, cc_address, bcc_address, subject, body_text, Date.now()]);
  return result.lastID;
}

async function updateDraft(draftId, accountId, fields) {
  await run(`
    UPDATE emails SET
      to_address = ?, cc_address = ?, bcc_address = ?, subject = ?, body_text = ?
    WHERE id = ? AND account_id = ?
  `, [
    fields.to_address || '', fields.cc_address || '', fields.bcc_address || '',
    fields.subject || '', fields.body_text || '', draftId, accountId
  ]);
}

async function getDraft(id) {
  return get('SELECT * FROM emails WHERE id = ? AND is_draft = 1', [id]);
}

// ── Attachments ──
async function replaceAttachmentsForEmail(emailId, attachments) {
  await run('DELETE FROM attachments WHERE email_id = ?', [emailId]);
  for (const a of attachments) {
    await run(`
      INSERT INTO attachments (email_id, filename, mime_type, size, part_id, imap_uid)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [emailId, a.filename || null, a.mime_type || null, a.size || null, a.part_id || null, a.imap_uid || null]);
  }
}

async function getAttachments(emailId) {
  return all('SELECT * FROM attachments WHERE email_id = ? ORDER BY id', [emailId]);
}

// Attachment row joined with its email + account for IMAP download
async function getAttachmentForDownload(attId) {
  return get(`
    SELECT a.*, e.account_id, e.message_id AS email_message_id,
           m.name AS mailbox_name, acc.email AS account_email
    FROM attachments a
    JOIN emails e ON a.email_id = e.id
    JOIN mailboxes m ON e.mailbox_id = m.id
    JOIN accounts acc ON e.account_id = acc.id
    WHERE a.id = ?
  `, [attId]);
}

async function markDeleted(id, isDeleted) {
  await run('UPDATE emails SET is_deleted = ? WHERE id = ?', [isDeleted ? 1 : 0, id]);
}

async function searchEmails(accountId, query, limit = 50, offset = 0) {
  const q = `%${query}%`;
  return all(LIST_SELECT + `
    WHERE e.account_id = ? AND e.is_deleted = 0
      AND (e.subject LIKE ? OR e.from_address LIKE ? OR e.body_text LIKE ?)
    ORDER BY e.date_received DESC
    LIMIT ? OFFSET ?
  `, [accountId, q, q, q, limit, offset]);
}

function close() {
  return new Promise((resolve) => db.close(() => resolve()));
}

module.exports = {
  addAccount,
  getAccounts,
  getAccount,
  getAccountByEmail,
  deleteAccount,
  updateAccountPassword,
  updateLastSync,
  addMailbox,
  getMailboxes,
  getMailbox,
  addEmail,
  getEmails,
  getStarred,
  getTrashed,
  getEmail,
  markRead,
  markFlagged,
  markDeleted,
  hardDeleteEmail,
  purgeTrash,
  getUnreadCounts,
  saveDraft,
  updateDraft,
  getDraft,
  replaceAttachmentsForEmail,
  getAttachments,
  getAttachmentForDownload,
  searchEmails,
  close,
};

async function getAccountByEmail(email) {
  return get('SELECT * FROM accounts WHERE email = ?', [email]);
}


