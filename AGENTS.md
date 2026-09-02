# AGENTS.md — LightMail

Lightweight local email client: Express + SQLite backend, vanilla-JS (ES modules, no build step) SPA frontend, IMAP sync (ImapFlow) + SMTP send (nodemailer). Author: Ritche Gerona.

## Commands

```bash
npm run dev    # start server (node server/index.js) on PORT 3000
npm start      # same but via nvm node 20 and kills anything on port 3000 first
npm test       # Jest + supertest (18 tests, <1s)
node --check <file>   # only syntax check available — no linter/typechecker configured
```

There is no git repo, no CI, no lint/format config. `update.sh`, `patch.sh`, `fix.sh`, and `*.log` in the root are stale one-off artifacts from earlier development — do not execute or treat them as current.

## Environment

- `.env` must contain `ENCRYPTION_KEY` (exactly 64 hex chars) — `server/encryption.js` calls `process.exit(1)` at require time without it, which surfaces as a confusing bare exit in any script that touches encryption/db.
- `PORT` optional (default 3000). `DB_PATH` env overrides the SQLite location (`data/mail.db`) — tests rely on this.
- `HOST` optional (default `127.0.0.1`) — the server is deliberately loopback-only; set `HOST=0.0.0.0` only if LAN access is truly wanted (the API has no auth).
- `MAIL_ALLOW_INSECURE_TLS=1` re-enables the old `rejectUnauthorized:false` behavior for self-signed IMAP/SMTP servers. Certificates are verified by default.
- `data/mail.db` is live local user data (real Gmail credentials, encrypted at rest). Never delete or commit it.

## Architecture

- `server/index.js` — Express app + JSON API. Routes: `/api/accounts` (+ `/unread`, `/:id/trash`), `/api/emails` (+ `/:id/read|flag|delete`, `DELETE /:id` permanent, `/:id/attachments[/:attId]` streaming from IMAP), `/api/drafts`, `/api/upload` (multer → `$TMPDIR/lightmail-uploads`, 25 MB cap, stale-file sweep at boot; `/api/send` validates attachment paths stay inside that dir), `/api/send`, `/api/sync/:id`, `PATCH /api/accounts/:id/password`. Exports `{ app }` and only calls `app.listen` inside `if (require.main === module)` — importing it must not bind a port. Background sync timers are skipped when `NODE_ENV === 'test'`. Keep it that way or Jest hangs on leaked handles.
- `server/db.js` — sqlite3 with hand-rolled promise wrappers (`run/get/all`). Schema + migrations run at require time via `db.exec`/`db.serialize`. Column migrations are enqueued **synchronously and unconditionally** (`ALTER TABLE ... ADD COLUMN` with swallowed duplicate-error callbacks) so SQLite's FIFO queue guarantees they complete before any request-time query — pragma-check-then-alter had a race that 500'd early requests. Mailboxes have `UNIQUE(account_id, name)`; emails have `UNIQUE(account_id, message_id)` with upsert-on-conflict. Sent-mail dedup: locally sent copies store nodemailer's real Message-ID in `rfc_message_id`; when sync later sees the same message it repoints the existing row instead of duplicating.
- `server/imap.js` — ImapFlow sync of INBOX/Sent/Drafts (newest 50 each) storing text/plain AND text/html bodies plus attachment metadata (part id + uid) for on-demand download via `downloadAttachmentStream()`. Per-account in-flight lock released in `finally` (was leaked forever after mid-sync errors). Connections always logout/close in `finally`. `server/smtp.js` — nodemailer with `{ to, cc, bcc, subject, body, attachments }` options object. `server/encryption.js` — AES-256-GCM (`iv:tag:ciphertext` hex).
- `public/` — no build step. ES modules loaded via `<script type="module" src="js/main.js">`: `main.js` (wiring/boot), `mail.js` (state + render + list/detail/folders/bulk/polling), `compose.js` (slide-over composer: CC/BCC, attachments upload, save-draft, minimize-to-pill; takes deps by injection to avoid circular imports), `keys.js` (j/k/Enter/r/f/c/e/s//? shortcuts), `theme.js` (system/light/dark via `[data-theme]` tokens + localStorage), `ui.js`/`icons.js` (SVG sprite `<use href="#i-*">`; every emoji was replaced), `api.js`. All element IDs in `index.html` are load-bearing. HTML mail renders in a sandboxed iframe (`allow-same-origin`, NO allow-scripts) with injected CSP blocking remote images until "Load images" is clicked.

## ImapFlow gotchas (each of these broke sync in real use)

- `mailboxOpen(path).messages` is `undefined` on Gmail — get counts via `client.status(path, { messages: true })`.
- `client.fetch()` with no selected mailbox **silently yields zero messages without throwing** — always `mailboxOpen()` first.
- `msg.flags` is a `Set` — use `.has('\\Seen')`; `.includes()` throws and aborts the whole sync loop.
- There are no `firstTextPart`/`downloadPart` methods. To get a body: walk `msg.bodyStructure` for a part id, then `client.download(uid, partId, { uid: true })` → `{ meta, content }` (content is a stream). Same walk collects attachments (`disposition === 'attachment'` or filename params); `collectAttachments()`/`findTextPart()`/`findHtmlPart()` live in imap.js.
- `fetch()` has no `order`/`count` options — they're silently ignored; bound results with an explicit range string.
- `client.list()` entries: `mb.path` is the full path (`[Gmail]/Sent Mail`), `mb.name` is only the last segment. Resolve folders via `mb.specialUse` (`\Sent`, `\Drafts`), not name matching (`resolveFolderPath()`).
- IMAP UIDs are per-mailbox: `message_id` must be namespaced (we use `${mailboxId}:${uid}`) or emails from different folders overwrite each other via the upsert. Attachment download parses the uid back out of that string.

## Testing

- Tests mock `../server/imap` and `../server/smtp` (no network) and run against `test/test_mail.db` (set via `DB_PATH`, deleted in `afterAll`). They cover accounts, password change, send (+attachments passed through to mocked smtp), flag, unread counts, STARRED/TRASH views, pagination offset, draft create/update/send-deletes-draft, multipart upload round-trip, attachment metadata.
- Run a subset with `npx jest -t 'Drafts API'` (matches describe/test names; the whole suite is one file, `test/api.test.js`). The frontend has zero automated tests — verify UI changes by booting the server and exercising the SPA manually.
- Jest sets `NODE_ENV=test` — server code checks this to suppress background `setTimeout` syncs.
- Live IMAP/SMTP verification requires a real account in `data/mail.db`; Gmail requires a 16-char App Password (regular passwords are rejected with "Application-specific password required"). Password updates go through the 🔑 UI button → `PATCH /api/accounts/:id/password`.

