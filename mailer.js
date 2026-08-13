const nodemailer = require("nodemailer");

// Email is opt-in, the same way Sentry is (see top of index.js): without
// SMTP_HOST/SMTP_USER/SMTP_PASS in .env, sendEmail() below just logs and
// returns instead of throwing, so the whole app runs fine in dev/CI with
// nothing configured. Set the SMTP_* vars in .env to turn it on for real.
let transporter = null;
let warnedOnce = false;

if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

const FROM = process.env.SMTP_FROM || "BuyTop <no-reply@buytop.app>";

// A small, consistent wrapper around the transactional emails below so
// every call site looks the same - a title, a one/two-line message, and
// an optional button linking back into the app.
const emailShell = ({ heading, body, ctaText, ctaUrl }) => `
  <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1f2937;">
    <h2 style="margin:0 0 12px;font-size:18px;">${heading}</h2>
    <p style="font-size:14px;line-height:1.6;color:#4b5563;">${body}</p>
    ${
      ctaUrl
        ? `<a href="${ctaUrl}" style="display:inline-block;margin-top:16px;padding:10px 20px;background:#eab308;color:#111827;text-decoration:none;border-radius:6px;font-size:14px;font-weight:600;">${ctaText || "View on BuyTop"}</a>`
        : ""
    }
    <p style="font-size:12px;color:#9ca3af;margin-top:28px;">You're receiving this because it relates to your activity on BuyTop.</p>
  </div>
`;

// Never let an email failure take down whatever real action triggered it
// (a booking, a payment, a message) - same "nice-to-have side effect"
// reasoning as createNotification() in index.js.
const sendEmail = async ({ to, subject, heading, body, ctaText, ctaUrl }) => {
  if (!to) return;
  if (!transporter) {
    if (!warnedOnce) {
      console.warn("sendEmail: SMTP_HOST/SMTP_USER/SMTP_PASS not set - emails are disabled.");
      warnedOnce = true;
    }
    return;
  }
  try {
    await transporter.sendMail({
      from: FROM,
      to,
      subject,
      html: emailShell({ heading: heading || subject, body, ctaText, ctaUrl }),
    });
  } catch (err) {
    console.error("sendEmail failed:", err.message);
  }
};

module.exports = { sendEmail };
