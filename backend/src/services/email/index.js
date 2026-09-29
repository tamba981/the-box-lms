'use strict';

const config = require('../../config/env');
const { formatCents } = require('../../lib/money');
const logger = require('../../lib/logger');

/**
 * Transactional email.
 *
 * Sending is best-effort: a mail failure must never fail the request that
 * triggered it (a failed reset email should not turn a 200 into a 500). When
 * no provider is configured — which is the default for local development — the
 * message is written to the log instead, so the whole flow is testable without
 * an API key or an inbox.
 *
 * Resend is used over SMTP because it needs no dependency: one authenticated
 * HTTPS POST.
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

async function deliver({ to, subject, html, text }) {
  /**
   * Refuse to send without a recipient.
   *
   * This is not paranoia: every template here originally returned its subject
   * and body but no `to`, and the transport happily logged
   * "To: undefined". The whole email feature was silently inert, and it failed
   * in the one direction nobody checks — it looked like it worked.
   */
  if (!to) {
    logger.error('email has no recipient — refusing to send', { subject });
    return { delivered: false, reason: 'no_recipient' };
  }

  if (!config.email.enabled) {
    logger.info('email not sent (no provider configured) — writing to log', { to, subject });

    // The body carrying the links is dumped in full so a developer can click
    // it — but only when debug logging is actually on, otherwise a test run is
    // buried in email bodies.
    if (logger.enabled('debug')) {
      process.stdout.write(
        `\n----- EMAIL (not delivered) -----\nTo: ${to}\nSubject: ${subject}\n\n${text}\n---------------------------------\n\n`
      );
    }

    return { delivered: false, reason: 'not_configured' };
  }

  try {
    const response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.email.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: config.email.from, to: [to], subject, html, text }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      logger.error('email provider rejected the message', { status: response.status, to, subject, body });
      return { delivered: false, reason: 'provider_error' };
    }

    const result = await response.json().catch(() => ({}));
    logger.info('email delivered', { to, subject, id: result.id });
    return { delivered: true, id: result.id };
  } catch (error) {
    logger.error('email delivery threw', { to, subject, error });
    return { delivered: false, reason: 'network_error' };
  }
}

/* ------------------------------------------------------------------ *
 * Layout
 * ------------------------------------------------------------------ */

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

const BRAND_NAVY = '#0f2b4c';

function layout({ heading, bodyHtml, ctaText, ctaUrl, footnote }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:24px 12px;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1c2431;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e6e8ec;">
    <tr><td style="background:${BRAND_NAVY};padding:22px 28px;color:#ffffff;font-size:18px;font-weight:700;letter-spacing:0.2px;">
      Wuteve Global Academy
    </td></tr>
    <tr><td style="padding:28px;">
      <h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;color:${BRAND_NAVY};">${escapeHtml(heading)}</h1>
      <div style="font-size:15px;line-height:1.6;color:#3d4757;">${bodyHtml}</div>
      ${ctaUrl ? `<p style="margin:26px 0 0;"><a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:${BRAND_NAVY};color:#ffffff;text-decoration:none;padding:13px 26px;border-radius:9px;font-weight:600;font-size:15px;">${escapeHtml(ctaText)}</a></p>
      <p style="margin:18px 0 0;font-size:13px;line-height:1.5;color:#8792a2;">If the button does not work, copy this address into your browser:<br><span style="color:#3d4757;word-break:break-all;">${escapeHtml(ctaUrl)}</span></p>` : ''}
      ${footnote ? `<p style="margin:22px 0 0;padding-top:18px;border-top:1px solid #eceef1;font-size:13px;line-height:1.5;color:#8792a2;">${footnote}</p>` : ''}
    </td></tr>
    <tr><td style="padding:16px 28px;background:#fafbfc;font-size:12px;color:#8792a2;border-top:1px solid #eceef1;">
      Wuteve Global Academy &middot; You are receiving this because you have an account with us.
    </td></tr>
  </table>
</body></html>`;
}

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

const firstNameOf = (user) => escapeHtml(user?.firstName || 'there');

function verificationEmail({ user, url }) {
  const heading = 'Confirm your email address';
  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    'Welcome to Wuteve Global Academy. Please confirm your email address to activate your account:',
    url,
    '',
    'This link expires in 24 hours.',
  ].join('\n');

  return {
    to: user.email,
    subject: 'Confirm your Wuteve Global Academy account',
    text,
    html: layout({
      heading,
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0;">Welcome to Wuteve Global Academy. Confirm this email address and your account is ready to use.</p>`,
      ctaText: 'Confirm my email',
      ctaUrl: url,
      footnote: 'This link expires in 24 hours. If you did not create an account, you can ignore this message.',
    }),
  };
}

function passwordResetEmail({ user, url }) {
  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    'We received a request to reset your password:',
    url,
    '',
    'This link can be used once and expires in 1 hour.',
    'If you did not ask for this, no action is needed — your password has not changed.',
  ].join('\n');

  return {
    to: user.email,
    subject: 'Reset your Wuteve Global Academy password',
    text,
    html: layout({
      heading: 'Reset your password',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0;">Use the button below to choose a new password. The link can be used once and expires in one hour.</p>`,
      ctaText: 'Choose a new password',
      ctaUrl: url,
      footnote: 'If you did not request this, no action is needed — your password has not changed.',
    }),
  };
}

function passwordChangedEmail({ user }) {
  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    'Your Wuteve Global Academy password was changed, and every signed-in device has been signed out.',
    '',
    'If this was not you, reset your password immediately.',
  ].join('\n');

  return {
    to: user.email,
    subject: 'Your password was changed',
    text,
    html: layout({
      heading: 'Your password was changed',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0 0 12px;">Your password was changed, and all other signed-in devices have been signed out.</p>
        <p style="margin:0;">If this was not you, reset your password immediately.</p>`,
      ctaText: 'Reset my password',
      ctaUrl: `${config.publicBaseUrl}/forgot-password.html`,
      footnote: 'For your security we notify you whenever your credentials change.',
    }),
  };
}

function welcomeEmail({ user }) {
  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    'Your Wuteve Global Academy account is active. Browse the catalog and enrol in your first course:',
    `${config.publicBaseUrl}/courses.html`,
  ].join('\n');

  return {
    to: user.email,
    subject: 'Your account is active',
    text,
    html: layout({
      heading: 'Your account is active',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0;">You can now browse the catalog and enrol in your first course.</p>`,
      ctaText: 'Browse courses',
      ctaUrl: `${config.publicBaseUrl}/courses.html`,
    }),
  };
}

function enrollmentEmail({ user, course, free }) {
  const url = `${config.publicBaseUrl}/student-dashboard.html#/course/${course.slug || course.id}`;
  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    free
      ? `You are enrolled in "${course.title}".`
      : `Your payment for "${course.title}" is confirmed and you are enrolled.`,
    '',
    url,
  ].join('\n');

  return {
    to: user.email,
    subject: `You are enrolled in ${course.title}`,
    text,
    html: layout({
      heading: 'You are enrolled',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0;">${free ? 'Your spot in' : 'Your payment is confirmed for'} <strong>${escapeHtml(course.title)}</strong> is ready. Your lessons are waiting.</p>`,
      ctaText: 'Start learning',
      ctaUrl: url,
    }),
  };
}

function certificateEmail({ user, certificate }) {
  const url = `${config.publicBaseUrl}/verify/${certificate.verificationCode}`;
  const text = [
    `Congratulations ${user.firstName || 'there'},`,
    '',
    `You have completed "${certificate.courseTitle}" and your certificate has been issued.`,
    `Certificate number: ${certificate.certificateNumber}`,
    '',
    `Verify or download it here: ${url}`,
  ].join('\n');

  return {
    to: user.email,
    subject: `Your certificate for ${certificate.courseTitle}`,
    text,
    html: layout({
      heading: 'Your certificate is ready',
      bodyHtml: `<p style="margin:0 0 12px;">Congratulations ${firstNameOf(user)},</p>
        <p style="margin:0 0 12px;">You have completed <strong>${escapeHtml(certificate.courseTitle)}</strong>.</p>
        <p style="margin:0;">Certificate number <strong>${escapeHtml(certificate.certificateNumber)}</strong>.</p>`,
      ctaText: 'View and verify certificate',
      ctaUrl: url,
      footnote: 'Anyone can verify this certificate using the link above.',
    }),
  };
}

function paymentReceiptEmail({ user, course, payment, nextUrl }) {
  const amount = formatCents(payment.amountCents, payment.currency);
  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    `Payment received: ${amount} for "${course.title}".`,
    `Reference: ${payment.id}`,
    '',
    `${config.publicBaseUrl}${nextUrl}`,
  ].join('\n');

  return {
    to: user.email,
    subject: `Receipt for ${course.title}`,
    text,
    html: layout({
      heading: 'Payment received',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0 0 12px;">We received <strong>${escapeHtml(amount)}</strong> for <strong>${escapeHtml(course.title)}</strong>.</p>
        <p style="margin:0;font-size:13px;color:#8792a2;">Reference ${escapeHtml(String(payment.id))}</p>`,
      ctaText: 'Go to my course',
      ctaUrl: `${config.publicBaseUrl}${nextUrl}`,
    }),
  };
}

function announcementEmail({ user, title, message, url }) {
  const text = [`Hello ${user.firstName || 'there'},`, '', title, '', message, url ? `\n${url}` : ''].join('\n');

  return {
    to: user.email,
    subject: title,
    text,
    html: layout({
      heading: title,
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0;white-space:pre-line;">${escapeHtml(message)}</p>`,
      ctaText: url ? 'Open Wuteve Global Academy' : undefined,
      ctaUrl: url || undefined,
    }),
  };
}

module.exports = {
  deliver,
  verificationEmail,
  passwordResetEmail,
  passwordChangedEmail,
  welcomeEmail,
  enrollmentEmail,
  certificateEmail,
  paymentReceiptEmail,
  announcementEmail,
  layout,
  escapeHtml,
};
