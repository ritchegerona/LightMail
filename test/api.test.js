const request = require('supertest');
const path = require('path');

// Set a temporary DB for tests
process.env.DB_PATH = path.join(__dirname, 'test_mail.db');
process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// Mock external modules to avoid network calls
jest.mock('../server/imap', () => ({ fetchEmails: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../server/smtp', () => ({ sendEmail: jest.fn().mockResolvedValue({ messageId: 'test-msg-id' }) }));

const { app } = require('../server/index');
const db = require('../server/db');

afterAll(async () => {
  await db.close();
  const fs = require('fs');
  try { fs.unlinkSync(process.env.DB_PATH); } catch (_) {}
});

describe('Account API', () => {
  let accountId;
  test('Create account', async () => {
    const res = await request(app)
      .post('/api/accounts')
      .send({
        email: 'testuser@example.com',
        password: 'password123',
        imap_host: 'imap.example.com',
        imap_port: 993,
        smtp_host: 'smtp.example.com',
        smtp_port: 587
      })
      .expect(200);
    expect(res.body.success).toBe(true);
    accountId = res.body.id;
  });

  test('Get accounts includes created', async () => {
    const res = await request(app).get('/api/accounts').expect(200);
    const found = res.body.find(a => a.email === 'testuser@example.com');
    expect(found).toBeDefined();
    expect(found.id).toBe(accountId);
  });

  test('Delete account', async () => {
    await request(app).delete(`/api/accounts/${accountId}`).expect(200);
    const res = await request(app).get('/api/accounts').expect(200);
    const found = res.body.find(a => a.id === accountId);
    expect(found).toBeUndefined();
  });
});

describe('Update Password API', () => {
  let accId;
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/accounts')
      .send({
        email: 'pwchange@example.com',
        password: 'old-secret',
        imap_host: 'imap.example.com',
        imap_port: 993,
        smtp_host: 'smtp.example.com',
        smtp_port: 587
      });
    accId = res.body.id;
  });

  test('returns 400 without password', async () => {
    await request(app).patch(`/api/accounts/${accId}/password`).send({}).expect(400);
  });

  test('returns 404 for unknown account', async () => {
    await request(app).patch('/api/accounts/99999/password').send({ password: 'x' }).expect(404);
  });

  test('updates stored encrypted password', async () => {
    const db = require('../server/db');
    const before = (await db.getAccount(accId)).encrypted_password;
    const res = await request(app)
      .patch(`/api/accounts/${accId}/password`)
      .send({ password: 'new-app-password-123' })
      .expect(200);
    expect(res.body.success).toBe(true);
    const after = (await db.getAccount(accId)).encrypted_password;
    expect(after).not.toBe(before);
    expect(after).not.toContain('new-app-password-123');
    // cleanup
    await db.deleteAccount(accId);
  });
});

describe('Send Email API', () => {
  let accId;
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/accounts')
      .send({
        email: 'sender@example.com',
        password: 'pw',
        imap_host: 'imap.example.com',
        imap_port: 993,
        smtp_host: 'smtp.example.com',
        smtp_port: 587
      });
    accId = res.body.id;
  });

  test('Send email returns success', async () => {
    const res = await request(app)
      .post('/api/send')
      .send({ account_id: accId, to: 'receiver@example.com', subject: 'Hello', body: 'Test body' })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.messageId).toBe('test-msg-id');
  });
});

// ═══════════════ Extended client-feature APIs ═══════════════

describe('Flag API', () => {
  let accId, emailId;
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/accounts')
      .send({ email: 'flagger@example.com', password: 'pw', imap_host: 'i', imap_port: 993, smtp_host: 's', smtp_port: 587 });
    accId = res.body.id;
    await db.addMailbox(accId, 'INBOX');
    const box = await db.getMailbox(accId, 'INBOX');
    emailId = await db.addEmail({
      account_id: accId, mailbox_id: box.id, message_id: box.id + ':1',
      from_address: 'x@y.z', subject: 'flag me', body_text: '', date_received: Date.now(), is_read: 0
    });
  });

  test('flags and unflags an email', async () => {
    await request(app).patch(`/api/emails/${emailId}/flag`).send({ is_flagged: true }).expect(200);
    expect((await db.getEmail(emailId)).is_flagged).toBe(1);
    await request(app).patch(`/api/emails/${emailId}/flag`).send({ is_flagged: false }).expect(200);
    expect((await db.getEmail(emailId)).is_flagged).toBe(0);
  });

  afterAll(async () => { await db.deleteAccount(accId); });
});

describe('Unread counts API', () => {
  let accId;
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/accounts')
      .send({ email: 'counter@example.com', password: 'pw', imap_host: 'i', imap_port: 993, smtp_host: 's', smtp_port: 587 });
    accId = res.body.id;
    await db.addMailbox(accId, 'INBOX');
    await db.addMailbox(accId, 'Sent');
    const inbox = await db.getMailbox(accId, 'INBOX');
    const sent = await db.getMailbox(accId, 'Sent');
    // 3 unread + 1 read in inbox, 1 unread in sent
    for (let i = 0; i < 4; i++) {
      await db.addEmail({ account_id: accId, mailbox_id: inbox.id, message_id: inbox.id + ':' + i,
        subject: 'i' + i, date_received: Date.now() - i * 1000, is_read: i === 0 ? 1 : 0 });
    }
    await db.addEmail({ account_id: accId, mailbox_id: sent.id, message_id: sent.id + ':1',
      subject: 's1', date_received: Date.now(), is_read: 0 });
  });

  test('returns accurate per-mailbox counts beyond visible page', async () => {
    const res = await request(app).get(`/api/accounts/${accId}/unread`).expect(200);
    expect(res.body.INBOX).toBe(3);
    expect(res.body.Sent).toBe(1);
    expect(res.body.Drafts).toBe(0);
    expect(res.body.STARRED).toBe(0);
  });

  afterAll(async () => { await db.deleteAccount(accId); });
});

describe('Starred / Trash / pagination', () => {
  let accId;
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/accounts')
      .send({ email: 'views@example.com', password: 'pw', imap_host: 'i', imap_port: 993, smtp_host: 's', smtp_port: 587 });
    accId = res.body.id;
    await db.addMailbox(accId, 'INBOX');
    const box = await db.getMailbox(accId, 'INBOX');
    // e0..e6, ascending dates so DESC order is e6..e0
    for (let i = 0; i < 7; i++) {
      await db.addEmail({ account_id: accId, mailbox_id: box.id, message_id: box.id + ':p' + i,
        subject: 'msg' + i, date_received: 1000000 + i * 1000, is_read: 0 });
    }
    // star msg0 (oldest), trash msg1
    const all = await db.getEmails(accId);
    const m0 = all.find(e => e.subject === 'msg0');
    const m1 = all.find(e => e.subject === 'msg1');
    await request(app).patch(`/api/emails/${m0.id}/flag`).send({ is_flagged: true }).expect(200);
    await request(app).patch(`/api/emails/${m1.id}/delete`).send({ is_deleted: true }).expect(200);
  });

  test('STARRED view returns only flagged', async () => {
    const res = await request(app).get(`/api/emails?account_id=${accId}&mailbox=STARRED`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].subject).toBe('msg0');
  });

  test('TRASH view returns only deleted', async () => {
    const res = await request(app).get(`/api/emails?account_id=${accId}&mailbox=TRASH`).expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].subject).toBe('msg1');
  });

  test('pagination returns disjoint pages in DESC order', async () => {
    const p1 = await request(app).get(`/api/emails?account_id=${accId}&limit=3&offset=0`).expect(200);
    const p2 = await request(app).get(`/api/emails?account_id=${accId}&limit=3&offset=3`).expect(200);
    const subjectsP1 = p1.body.map(e => e.subject);
    const subjectsP2 = p2.body.map(e => e.subject);
    expect(subjectsP1).toEqual(['msg6', 'msg5', 'msg4']);
    expect(subjectsP2).toEqual(['msg3', 'msg2', 'msg0']); // msg1 is trashed
    expect(subjectsP1.filter(s => subjectsP2.includes(s))).toHaveLength(0);
  });

  test('purge trash permanently deletes', async () => {
    const res = await request(app).delete(`/api/accounts/${accId}/trash`).expect(200);
    expect(res.body.purged).toBeGreaterThanOrEqual(1);
    const trash = await request(app).get(`/api/emails?account_id=${accId}&mailbox=TRASH`);
    expect(trash.body).toHaveLength(0);
  });

  afterAll(async () => { await db.deleteAccount(accId); });
});

describe('Drafts API', () => {
  let accId;
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/accounts')
      .send({ email: 'drafter@example.com', password: 'pw', imap_host: 'i', imap_port: 993, smtp_host: 's', smtp_port: 587 });
    accId = res.body.id;
  });

  let draftId;
  test('creates a draft', async () => {
    const res = await request(app)
      .post('/api/drafts')
      .send({ account_id: accId, to: 'a@b.c', subject: 'WIP', body: 'half done' })
      .expect(200);
    draftId = res.body.draft_id;
    const draft = await db.getDraft(draftId);
    expect(draft.subject).toBe('WIP');
    expect(draft.is_draft).toBe(1);
  });

  test('updates an existing draft', async () => {
    await request(app)
      .post('/api/drafts')
      .send({ account_id: accId, draft_id: draftId, to: 'a@b.c', subject: 'WIP v2', body: 'more done' })
      .expect(200);
    expect((await db.getDraft(draftId)).subject).toBe('WIP v2');
  });

  test('sending with draft_id removes the draft', async () => {
    await request(app)
      .post('/api/send')
      .send({ account_id: accId, to: 'a@b.c', subject: 'WIP final', body: 'done', draft_id: draftId })
      .expect(200);
    expect(await db.getDraft(draftId)).toBeUndefined();
  });

  afterAll(async () => { await db.deleteAccount(accId); });
});

describe('Upload + attachment send', () => {
  let accId;
  const fs = require('fs');
  beforeAll(async () => {
    const res = await request(app)
      .post('/api/accounts')
      .send({ email: 'uploader@example.com', password: 'pw', imap_host: 'i', imap_port: 993, smtp_host: 's', smtp_port: 587 });
    accId = res.body.id;
  });

  test('upload accepts multipart files', async () => {
    const res = await request(app)
      .post('/api/upload')
      .attach('files', Buffer.from('attachment-content'), { filename: 'notes.txt', contentType: 'text/plain' })
      .expect(200);
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].filename).toBe('notes.txt');
    expect(fs.existsSync(res.body.files[0].path)).toBe(true);

    // sending consumes and removes the temp file
    const { sendEmail } = require('../server/smtp');
    const attPath = res.body.files[0].path;
    await request(app)
      .post('/api/send')
      .send({
        account_id: accId, to: 'r@x.y', subject: 'with att', body: 'see attached',
        attachments: [{ filename: 'notes.txt', mimetype: 'text/plain', path: attPath }]
      })
      .expect(200);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        attachments: [expect.objectContaining({ filename: 'notes.txt', path: attPath })]
      })
    );
    expect(fs.existsSync(attPath)).toBe(false);
  });

  afterAll(async () => { await db.deleteAccount(accId); });
});

describe('Attachment sync metadata', () => {
  test('replaceAttachmentsForEmail stores part info', async () => {
    const acc = await request(app)
      .post('/api/accounts')
      .send({ email: 'attsync@example.com', password: 'pw', imap_host: 'i', imap_port: 993, smtp_host: 's', smtp_port: 587 });
    const accId = acc.body.id;
    await db.addMailbox(accId, 'INBOX');
    const box = await db.getMailbox(accId, 'INBOX');
    const emailId = await db.addEmail({ account_id: accId, mailbox_id: box.id,
      message_id: box.id + ':9', subject: 'pdf attached', date_received: Date.now(), is_read: 0 });
    await db.replaceAttachmentsForEmail(emailId, [
      { part_id: '2', filename: 'report.pdf', mime_type: 'application/pdf', size: 12345, imap_uid: 9 }
    ]);
    const list = await db.getAttachments(emailId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ part_id: '2', filename: 'report.pdf', imap_uid: 9 });
    // has_attachments indicator surfaces in list queries
    const row = (await db.getEmails(accId)).find(e => e.id === emailId);
    expect(row.has_attachments).toBe(1);
    await db.deleteAccount(accId);
  });

  test('replaceAttachmentsForEmail handles multiple attachments', async () => {
    const acc = await request(app)
      .post('/api/accounts')
      .send({ email: 'multiatts@example.com', password: 'pw', imap_host: 'i', imap_port: 993, smtp_host: 's', smtp_port: 587 });
    const accId = acc.body.id;
    await db.addMailbox(accId, 'INBOX');
    const box = await db.getMailbox(accId, 'INBOX');
    const emailId = await db.addEmail({ account_id: accId, mailbox_id: box.id,
      message_id: box.id + ':42', subject: 'multi att', date_received: Date.now(), is_read: 0 });
    await db.replaceAttachmentsForEmail(emailId, [
      { part_id: '1', filename: 'doc1.pdf', mime_type: 'application/pdf', size: 5000, imap_uid: 42 },
      { part_id: '2', filename: 'doc2.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 8000, imap_uid: 42 },
      { part_id: '3', filename: 'image.png', mime_type: 'image/png', size: 2000, imap_uid: 42 }
    ]);
    const list = await db.getAttachments(emailId);
    expect(list).toHaveLength(3);
    const filenames = list.map(a => a.filename).sort();
    expect(filenames).toEqual(['doc1.pdf', 'doc2.xlsx', 'image.png']);
    await db.deleteAccount(accId);
  });

  test('replaceAttachmentsForEmail re-sync overwrites existing attachments', async () => {
    const acc = await request(app)
      .post('/api/accounts')
      .send({ email: 'reclaim@example.com', password: 'pw', imap_host: 'i', imap_port: 993, smtp_host: 's', smtp_port: 587 });
    const accId = acc.body.id;
    await db.addMailbox(accId, 'INBOX');
    const box = await db.getMailbox(accId, 'INBOX');
    const emailId = await db.addEmail({ account_id: accId, mailbox_id: box.id,
      message_id: box.id + ':15', subject: 're-sync test', date_received: Date.now(), is_read: 0 });
    // First sync: single attachment
    await db.replaceAttachmentsForEmail(emailId, [
      { part_id: '5', filename: 'old.pdf', mime_type: 'application/pdf', size: 1000, imap_uid: 15 }
    ]);
    let list = await db.getAttachments(emailId);
    expect(list).toHaveLength(1);
    expect(list[0].filename).toBe('old.pdf');
    // Second sync: replace with three attachments
    await db.replaceAttachmentsForEmail(emailId, [
      { part_id: '1', filename: 'new1.txt', mime_type: 'text/plain', size: 100, imap_uid: 15 },
      { part_id: '2', filename: 'new2.txt', mime_type: 'text/plain', size: 200, imap_uid: 15 },
      { part_id: '3', filename: 'new3.txt', mime_type: 'text/plain', size: 300, imap_uid: 15 }
    ]);
    list = await db.getAttachments(emailId);
    expect(list).toHaveLength(3);
    const filenames = list.map(a => a.filename).sort();
    expect(filenames).toEqual(['new1.txt', 'new2.txt', 'new3.txt']);
    // Old attachment is gone
    expect(list.some(a => a.filename === 'old.pdf')).toBe(false);
    await db.deleteAccount(accId);
  });

  test('replaceAttachmentsForEmail handles attachment without explicit filename', async () => {
    const acc = await request(app)
      .post('/api/accounts')
      .send({ email: 'nofile@example.com', password: 'pw', imap_host: 'i', imap_port: 993, smtp_host: 's', smtp_port: 587 });
    const accId = acc.body.id;
    await db.addMailbox(accId, 'INBOX');
    const box = await db.getMailbox(accId, 'INBOX');
    const emailId = await db.addEmail({ account_id: accId, mailbox_id: box.id,
      message_id: box.id + ':7', subject: 'nameless att', date_received: Date.now(), is_read: 0 });
    // Simulate an attachment part with disposition but no filename field
    await db.replaceAttachmentsForEmail(emailId, [
      { part_id: '3', mime_type: 'application/octet-stream', size: 4242, imap_uid: 7 }
    ]);
    const list = await db.getAttachments(emailId);
    expect(list).toHaveLength(1);
    // Filename should default to something reasonable when missing
    expect(list[0].filename).toBeDefined();
    await db.deleteAccount(accId);
  });

  test('getAttachments returns empty array for email with no attachments', async () => {
    const acc = await request(app)
      .post('/api/accounts')
      .send({ email: 'noattch@example.com', password: 'pw', imap_host: 'i', imap_port: 993, smtp_host: 's', smtp_port: 587 });
    const accId = acc.body.id;
    await db.addMailbox(accId, 'INBOX');
    const box = await db.getMailbox(accId, 'INBOX');
    const emailId = await db.addEmail({ account_id: accId, mailbox_id: box.id,
      message_id: box.id + ':3', subject: 'plain text only', date_received: Date.now(), is_read: 0 });
    const list = await db.getAttachments(emailId);
    expect(list).toHaveLength(0);
    await db.deleteAccount(accId);
  });
});
