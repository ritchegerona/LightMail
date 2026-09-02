const nodemailer = require('nodemailer');
const { decrypt } = require('./encryption');

/**
 * Send an email.
 * @param {object} account - account row (smtp host/port, encrypted password)
 * @param {object} opts    - { to, cc?, bcc?, subject, body?, attachments?: [{path, filename, contentType}] }
 */
async function sendEmail(account, opts = {}) {
  const { to, cc = '', bcc = '', subject, body = '', attachments = [] } = opts;
  const password = decrypt(account.encrypted_password);
  const port = account.smtp_port;
  const secure = (port === 465); // 465 uses SSL, 587 uses STARTTLS

  const transporter = nodemailer.createTransport({
    host: account.smtp_host,
    port: port,
    secure: secure,
    auth: { user: account.email, pass: password },
    // Verify server certs by default; opt-out only for self-signed servers
    tls: process.env.MAIL_ALLOW_INSECURE_TLS === '1' ? { rejectUnauthorized: false } : {}
  });

  try {
    const info = await transporter.sendMail({
      from: account.email,
      to,
      cc,
      bcc,
      subject,
      text: body,
      attachments: attachments.map(a => ({
        filename: a.filename,
        path: a.path,
        contentType: a.contentType || a.mime_type
      })),
    });
    return info;
  } catch (error) {
    // Improve error messages
    if (error.response && error.response.includes('Application-specific password')) {
      throw new Error('Gmail/Google requires an App Password. Generate one at https://myaccount.google.com/apppasswords');
    }
    if (error.message && error.message.includes('Invalid login')) {
      throw new Error('SMTP login failed. Please check your email/password or use an App Password for Gmail.');
    }
    throw error;
  }
}

module.exports = { sendEmail };
