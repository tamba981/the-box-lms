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

async function deliver({ to, subject, html, text, replyTo, attachments }) {
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
      body: JSON.stringify({
        from: config.email.from,
        to: [to],
        subject,
        html,
        text,
        // Carried through only when set. The contact notification uses it so that
        // replying in a mail client answers the person who wrote in, rather than
        // the platform.
        ...(replyTo ? { reply_to: replyTo } : {}),
        // Base64 attachments, in the shape Resend expects. Only the certificate
        // email uses this, so that a graduate gets the document itself rather
        // than a link they must remember to open.
        ...(attachments && attachments.length ? { attachments } : {}),
      }),
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

/**
 * TODO(marketing): add a `marketingOptOut` flag, a tokenised unsubscribe link and
 * a List-Unsubscribe header when a campaign/marketing feature is built. Every
 * message in this file is currently transactional or an account notice
 * (announcements included), which is why none of them carries an unsubscribe
 * link.
 */
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
      Wuteve Global Academy &middot; You are receiving this email because you have an account with Wuteve Global Academy.
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

  /**
   * Name the credential the student actually earned.
   *
   * A graduate who paid for a diploma and received an email about a
   * "certificate" has been told, in writing, that the school disagrees with
   * them about what they bought. The model defaults to `certificate`, so an
   * older record still reads correctly.
   */
  const credential = certificate.credential === 'diploma' || certificate.credential === 'degree'
    ? certificate.credential
    : 'certificate';
  const noun = credential;
  const numbered = credential.charAt(0).toUpperCase() + credential.slice(1);

  const text = [
    `Congratulations ${user.firstName || 'there'},`,
    '',
    `You have completed "${certificate.courseTitle}" and your ${noun} has been issued.`,
    `${numbered} number: ${certificate.certificateNumber}`,
    '',
    `The PDF is attached to this email.`,
    `Verify it here: ${url}`,
  ].join('\n');

  /**
   * Attached rather than merely linked.
   *
   * `issueFor` renders the document as the certificate is created, so it is in
   * practice always present. The guard covers a record issued before documents
   * existed, which would otherwise attach the string "undefined".
   */
  const safeNumber = String(certificate.certificateNumber || 'document').replace(/[^A-Za-z0-9._-]/g, '-');
  const attachments = certificate.pdfBase64
    ? [{ filename: `${noun}-${safeNumber}.pdf`, content: certificate.pdfBase64 }]
    : undefined;

  return {
    to: user.email,
    subject: `Your ${noun} for ${certificate.courseTitle}`,
    text,
    attachments,
    html: layout({
      heading: `Your ${noun} is ready`,
      bodyHtml: `<p style="margin:0 0 12px;">Congratulations ${firstNameOf(user)},</p>
        <p style="margin:0 0 12px;">You have completed <strong>${escapeHtml(certificate.courseTitle)}</strong> and your ${noun} has been issued.</p>
        <p style="margin:0 0 12px;">${numbered} number <strong>${escapeHtml(certificate.certificateNumber)}</strong>.</p>
        <p style="margin:0;">Your ${noun} is attached to this email as a PDF.</p>`,
      ctaText: `View and verify ${noun}`,
      ctaUrl: url,
      footnote: `Anyone can verify this ${noun} using the link above.`,
    }),
  };
}

function paymentReceiptEmail({ user, course, payment, nextUrl }) {
  const amount = formatCents(payment.amountCents, payment.currency);
  /**
   * A manual order has a reference the student was told to write on their
   * payment, and that is the number they will quote back to us. Showing the
   * database id here instead would be a number they have never seen.
   */
  const reference = payment.orderId || payment.id;
  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    `Payment received: ${amount} for "${course.title}".`,
    `Reference: ${reference}`,
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
        <p style="margin:0;font-size:13px;color:#8792a2;">Reference ${escapeHtml(String(reference))}</p>`,
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

/**
 * A message from the public contact form, addressed to the academy's inbox.
 *
 * `replyTo` is the whole point of the notification: whoever reads it can hit
 * reply and answer the person directly, instead of copying an address out of the
 * body. The reason is put in the subject too, so a partnership enquiry can be
 * spotted and filed without opening it.
 */
function contactMessageEmail({ name, email: address, reason, subject, message, inbox }) {
  const label = reason ? reason.charAt(0).toUpperCase() + reason.slice(1) : 'General';

  const text = [
    `From:    ${name} <${address}>`,
    `Reason:  ${label}`,
    `Subject: ${subject}`,
    '',
    message,
  ].join('\n');

  return {
    to: inbox,
    replyTo: address,
    subject: `[Contact - ${label}] ${subject}`,
    text,
    html: layout({
      heading: 'New contact message',
      bodyHtml: `<p style="margin:0 0 6px;"><strong>${escapeHtml(name)}</strong> &lt;${escapeHtml(address)}&gt;</p>
        <p style="margin:0 0 14px;font-size:13px;color:#8792a2;">${escapeHtml(label)}</p>
        <p style="margin:0 0 12px;"><strong>${escapeHtml(subject)}</strong></p>
        <p style="margin:0;white-space:pre-line;">${escapeHtml(message)}</p>`,
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Notifications about progress, payments and account state
 * ------------------------------------------------------------------ */

/** Sent once, when the final lesson is completed. */
function courseCompletedEmail({ user, course, certificate }) {
  const dashboardUrl = `${config.publicBaseUrl}/student-dashboard.html`;
  const hours = Number(course.durationHours) > 0 ? `${course.durationHours} hours of material` : null;
  // A certificate that is waiting to be paid for has a number but has not been
  // issued. Saying "has been issued" here would be the platform congratulating a
  // student on a document it is withholding.
  const awaitingPayment = Boolean(certificate) && certificate.status === 'pending_payment';
  const credential = certificate && certificate.certificateNumber && !awaitingPayment
    ? `Your ${certificate.credential === 'diploma' ? 'diploma' : 'certificate'} has been issued - number ${certificate.certificateNumber}.`
    : awaitingPayment
      ? `Your ${certificate.credential === 'diploma' ? 'diploma' : 'certificate'} is reserved as number ${certificate.certificateNumber}. Open your dashboard to pay ${course.certificateFeeLabel || 'the certificate fee'} and claim it.`
      : null;

  const text = [
    `Congratulations ${user.firstName || 'there'},`,
    '',
    `You have completed "${course.title}".`,
    hours ? `That is ${hours}, finished.` : '',
    credential || '',
    '',
    `Your dashboard: ${dashboardUrl}`,
  ].filter((line) => line !== '').join('\n');

  return {
    to: user.email,
    subject: `You have completed "${course.title}"`,
    text,
    html: layout({
      heading: 'You finished the course',
      bodyHtml: `<p style="margin:0 0 12px;">Congratulations ${firstNameOf(user)},</p>
        <p style="margin:0 0 12px;">You have completed <strong>${escapeHtml(course.title)}</strong>.</p>
        ${credential ? `<p style="margin:0 0 12px;">${escapeHtml(credential)}</p>` : ''}
        <p style="margin:0;">Everything you worked through stays available from your dashboard.</p>`,
      ctaText: 'Go to your dashboard',
      ctaUrl: dashboardUrl,
    }),
  };
}

/** The student said they have sent the money; a person still has to check. */
function manualPaymentSubmittedEmail({ user, course, payment }) {
  const amount = formatCents(payment.amountCents, payment.currency);
  const dashboardUrl = `${config.publicBaseUrl}/student-dashboard.html`;
  const inbox = config.email.inbox;
  // A certificate payment and a course payment are confirmed the same way but
  // promise different things, and the student has to know which they bought.
  const forCertificate = (payment.purpose || 'enrollment') === 'certificate';

  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    forCertificate
      ? `We have your note that the certificate fee of ${amount} for "${course.title}" has been sent.`
      : `We have your note that the payment for "${course.title}" has been sent.`,
    `Order:  ${payment.orderId}`,
    `Amount: ${amount}`,
    '',
    'Someone will check it by hand, usually within 30 minutes during working hours.',
    forCertificate
      ? 'You will get another email as soon as it is confirmed, and your certificate becomes downloadable then.'
      : 'You will get another email as soon as it is confirmed, and your place on the course opens then.',
    '',
    `If you have not heard from us within an hour, write to ${inbox} with the order number.`,
    '',
    `Your dashboard: ${dashboardUrl}`,
  ].join('\n');

  return {
    to: user.email,
    subject: `We have received your payment - ${payment.orderId}`,
    text,
    html: layout({
      heading: 'Payment received - being checked',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0 0 12px;">We have your note that the ${forCertificate ? 'certificate fee' : 'payment'} for <strong>${escapeHtml(course.title)}</strong> has been sent.</p>
        <p style="margin:0 0 4px;">Order <strong>${escapeHtml(payment.orderId)}</strong></p>
        <p style="margin:0 0 12px;">Amount <strong>${escapeHtml(amount)}</strong></p>
        <p style="margin:0 0 12px;">Someone will check it by hand, usually within 30 minutes during working hours. You will get another email when it is confirmed, and ${forCertificate ? 'your certificate becomes downloadable then' : 'your place opens then'}.</p>
        <p style="margin:0;">If you have not heard from us within an hour, write to ${escapeHtml(inbox)} with the order number.</p>`,
      ctaText: 'View your dashboard',
      ctaUrl: dashboardUrl,
    }),
  };
}

/** A person looked at the payment and could not match it. */
function manualPaymentRejectedEmail({ user, course, payment, reason }) {
  const amount = formatCents(payment.amountCents, payment.currency);
  const inbox = config.email.inbox;

  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    `We could not confirm the payment for "${course.title}".`,
    `Order:  ${payment.orderId}`,
    `Amount: ${amount}`,
    '',
    `Reason: ${reason}`,
    '',
    'The order has been cancelled. Nothing has been charged by us for it.',
    `If you believe this is wrong, write to ${inbox} with the order number and your payment receipt.`,
  ].join('\n');

  return {
    to: user.email,
    subject: `Payment verification failed - ${payment.orderId}`,
    text,
    html: layout({
      heading: 'We could not confirm that payment',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0 0 12px;">We could not confirm the payment for <strong>${escapeHtml(course.title)}</strong>.</p>
        <p style="margin:0 0 4px;">Order <strong>${escapeHtml(payment.orderId)}</strong></p>
        <p style="margin:0 0 14px;">Amount <strong>${escapeHtml(amount)}</strong></p>
        <p style="margin:0 0 14px;padding:10px 14px;background:#fdf2f2;border-left:3px solid #c0392b;">${escapeHtml(reason)}</p>
        <p style="margin:0 0 12px;">The order has been cancelled, and nothing has been charged by us for it.</p>
        <p style="margin:0;">If you believe this is wrong, write to ${escapeHtml(inbox)} with the order number and your payment receipt.</p>`,
    }),
  };
}

function cvSubmittedEmail({ user }) {
  const profileUrl = `${config.publicBaseUrl}/instructor-dashboard.html`;

  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    'We have your CV. Our team will review it within 48 hours.',
    'You can keep building your lessons meanwhile - nothing is blocked while it is reviewed.',
    '',
    'You will get an email when the review is finished.',
    '',
    `Your profile: ${profileUrl}`,
  ].join('\n');

  return {
    to: user.email,
    subject: 'We have received your CV - review within 48 hours',
    text,
    html: layout({
      heading: 'CV received',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0 0 12px;">We have your CV. Our team will review it within 48 hours.</p>
        <p style="margin:0 0 12px;">You can keep building your lessons meanwhile - nothing is blocked while it is reviewed.</p>
        <p style="margin:0;">You will get an email when the review is finished.</p>`,
      ctaText: 'View your profile',
      ctaUrl: profileUrl,
    }),
  };
}

function cvApprovedEmail({ user }) {
  const profileUrl = `${config.publicBaseUrl}/instructor-dashboard.html`;

  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    'Your CV has been reviewed and approved.',
    'It is now shown on your course pages as a verified credential.',
    '',
    `Your dashboard: ${profileUrl}`,
  ].join('\n');

  return {
    to: user.email,
    subject: 'Your CV has been approved',
    text,
    html: layout({
      heading: 'Your CV is approved',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0 0 12px;">Your CV has been reviewed and approved.</p>
        <p style="margin:0;">Course pages now mark your credentials as verified.</p>`,
      ctaText: 'Go to your dashboard',
      ctaUrl: profileUrl,
    }),
  };
}

function cvRejectedEmail({ user, reason }) {
  const profileUrl = `${config.publicBaseUrl}/instructor-dashboard.html`;
  const inbox = config.email.inbox;

  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    'Our team reviewed your CV and needs a change before it can be approved.',
    '',
    `Reason: ${reason}`,
    '',
    'Upload an updated CV from your profile and it will be reviewed again.',
    '',
    `Your profile: ${profileUrl}`,
    `Questions: ${inbox}`,
  ].join('\n');

  return {
    to: user.email,
    subject: 'Your CV requires attention',
    text,
    html: layout({
      heading: 'Your CV needs a change',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0 0 14px;">Our team reviewed your CV and needs a change before it can be approved.</p>
        <p style="margin:0 0 14px;padding:10px 14px;background:#fdf6ec;border-left:3px solid #b7791f;">${escapeHtml(reason)}</p>
        <p style="margin:0 0 12px;">Upload an updated CV from your profile and it will be reviewed again.</p>
        <p style="margin:0;">Questions? Write to ${escapeHtml(inbox)}.</p>`,
      ctaText: 'Update your CV',
      ctaUrl: profileUrl,
    }),
  };
}

/**
 * An account an administrator created.
 *
 * The password is deliberately absent: an administrator chooses it and tells the
 * instructor out of band. Emailing a password would put it in an inbox, in a
 * backup and in whatever forwards that mail next.
 */
function instructorAccountEmail({ user }) {
  const dashboardUrl = `${config.publicBaseUrl}/instructor-dashboard.html`;
  const forgotUrl = `${config.publicBaseUrl}/forgot-password.html`;

  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    'An instructor account has been created for you at Wuteve Global Academy.',
    '',
    `Sign in with this address: ${user.email}`,
    'Use the password your administrator gave you. If you do not have one,',
    `set your own here: ${forgotUrl}`,
    '',
    `Your dashboard: ${dashboardUrl}`,
  ].join('\n');

  return {
    to: user.email,
    subject: 'Your Wuteve Global Academy instructor account is ready',
    text,
    html: layout({
      heading: 'Your instructor account is ready',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0 0 12px;">An instructor account has been created for you at Wuteve Global Academy.</p>
        <p style="margin:0 0 4px;">Sign in with <strong>${escapeHtml(user.email)}</strong></p>
        <p style="margin:0 0 12px;">Use the password your administrator gave you, or set your own with <a href="${escapeHtml(forgotUrl)}" style="color:#0f2b4c;">forgot password</a>.</p>
        <p style="margin:0;">From your dashboard you can write lessons, add a video and publish a course.</p>`,
      ctaText: 'Open your dashboard',
      ctaUrl: dashboardUrl,
    }),
  };
}

function newsletterWelcomeEmail({ email }) {
  const coursesUrl = `${config.publicBaseUrl}/courses.html`;
  const inbox = config.email.inbox;

  const text = [
    'Welcome to the Wuteve Global Academy community.',
    '',
    'You will be the first to hear about new courses and updates.',
    'You can leave the list at any time by replying to any of our emails.',
    '',
    `Browse the catalog: ${coursesUrl}`,
    `Questions: ${inbox}`,
  ].join('\n');

  return {
    to: email,
    subject: 'Welcome to the Wuteve Global Academy community',
    text,
    html: layout({
      heading: 'You are on the list',
      bodyHtml: `<p style="margin:0 0 12px;">Welcome to the Wuteve Global Academy community.</p>
        <p style="margin:0 0 12px;">You will be the first to hear about new courses and updates.</p>
        <p style="margin:0;">You can leave the list at any time by replying to any of our emails, or writing to ${escapeHtml(inbox)}.</p>`,
      ctaText: 'Browse the catalog',
      ctaUrl: coursesUrl,
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Partnership enquiries (business, university, government)
 * ------------------------------------------------------------------ */

const AUDIENCE_LABELS = {
  business: 'Company',
  university: 'University or college',
  government: 'Government or public body',
};

/**
 * One enquiry from an organisation, addressed to whoever answers partnerships.
 *
 * `replyTo` is the enquirer, so replying is a normal reply rather than a copy
 * and paste. Every field is optional except the four the form requires, and the
 * ones that are empty are left out rather than printed as "undefined".
 */
function businessEnquiryEmail({ lead, inbox }) {
  const to = inbox || config.businessInbox;
  const label = AUDIENCE_LABELS[lead.audience] || 'Enquiry';
  const rows = [
    ['Organisation', lead.company],
    ['Contact', lead.contactName],
    ['Email', lead.email],
    ['Phone', lead.phone],
    ['Team size', lead.teamSize],
    ['Timeline', lead.timeline],
    ['Interested in', Array.isArray(lead.interests) && lead.interests.length ? lead.interests.join(', ') : null],
  ].filter((row) => row[1]);

  const text = [
    `${label}: ${lead.company}`,
    '',
    ...rows.slice(1).map(([name, value]) => `${name}: ${value}`),
    lead.message ? '' : null,
    lead.message || null,
  ].filter((line) => line !== null).join('\n');

  return {
    to,
    replyTo: lead.email,
    subject: `${label} enquiry - ${lead.company}`,
    text,
    html: layout({
      heading: 'New partnership enquiry',
      bodyHtml: `<p style="margin:0 0 14px;"><strong>${escapeHtml(lead.company)}</strong> sent an enquiry through the ${escapeHtml(
        (AUDIENCE_LABELS[lead.audience] || 'partnership').toLowerCase()
      )} page.</p>
        <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 14px;">
          ${rows
            .map(
              ([name, value]) =>
                `<tr><td style="padding:4px 12px 4px 0;color:#6b7280;white-space:nowrap;vertical-align:top;">${escapeHtml(
                  name
                )}</td><td style="padding:4px 0;">${escapeHtml(value)}</td></tr>`
            )
            .join('')}
        </table>
        ${lead.message ? `<p style="margin:0 0 12px;white-space:pre-wrap;">${escapeHtml(lead.message)}</p>` : ''}
        <p style="margin:0;color:#6b7280;font-size:14px;">Replying to this email reaches the sender directly.</p>`,
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Instructor applications
 *
 * Three separate emails rather than one "application status" message: the
 * applicant needs to know it arrived, know it succeeded, or know why it did
 * not. A single template with a status field ends up saying the wrong one.
 * ------------------------------------------------------------------ */

function instructorApplicationReceivedEmail({ user }) {  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    'We received your application to teach on Wuteve Global Academy.',
    '',
    'Our team reviews every application by hand, and you will hear from us within',
    '48 hours. You do not need to do anything in the meantime.',
    '',
    'If you did not apply, you can ignore this email and the account will not be',
    'approved.',
  ].join('\n');

  return {
    to: user.email,
    subject: 'We received your instructor application',
    text,
    html: layout({
      heading: 'Application received',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0 0 12px;">We received your application to teach on Wuteve Global Academy.</p>
        <p style="margin:0 0 12px;">Our team reviews every application by hand. You will hear from us within 48 hours, and there is nothing you need to do in the meantime.</p>
        <p style="margin:0;color:#475569;">If you did not apply, you can ignore this email and the account will not be approved.</p>`,
    }),
  };
}

function instructorApprovedEmail({ user }) {
  const dashboardUrl = `${config.publicBaseUrl}/instructor-dashboard.html`;

  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    'Your application has been approved and your instructor account is active.',
    '',
    'You can sign in and start creating courses. Every course you write is yours:',
    'you set the price, and you decide what it contains.',
    '',
    `Your dashboard: ${dashboardUrl}`,
  ].join('\n');

  return {
    to: user.email,
    subject: 'Your Wuteve instructor account is approved',
    text,
    html: layout({
      heading: 'Welcome to Wuteve',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0 0 12px;">Your application has been approved and your instructor account is active.</p>
        <p style="margin:0 0 12px;">You can sign in and start creating courses. Every course you write is yours: you set the price, and you decide what it contains.</p>
        <p style="margin:0;"><a href="${dashboardUrl}">Open your dashboard</a></p>`,
    }),
  };
}

function instructorRejectedEmail({ user, reason }) {
  const safeReason = reason ? String(reason).trim() : '';

  const text = [
    `Hello ${user.firstName || 'there'},`,
    '',
    'We have reviewed your application to teach on Wuteve Global Academy and are',
    'not able to approve it at this time.',
    '',
    safeReason ? `Reason: ${safeReason}` : '',
    '',
    'If you believe that is wrong, reply to this message and we will look again.',
    'The certificate courses remain open to you as a student.',
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');

  return {
    to: user.email,
    subject: 'About your Wuteve instructor application',
    text,
    html: layout({
      heading: 'About your application',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${firstNameOf(user)},</p>
        <p style="margin:0 0 12px;">We have reviewed your application to teach on Wuteve Global Academy and are not able to approve it at this time.</p>
        ${safeReason ? `<p style="margin:0 0 12px;"><strong>Reason given:</strong> ${escapeHtml(safeReason)}</p>` : ''}
        <p style="margin:0;">If you believe that is wrong, reply to this message and we will look again. The certificate courses remain open to you as a student.</p>`,
    }),
  };
}

/**
 * Offline admissions.
 *
 * Three messages: one when the application arrives, one when it is approved
 * (carrying what to bring), and one when it is not. All three repeat the
 * tracking number, because that is the only handle the applicant has.
 */

function admissionReceivedEmail({ application }) {
  const statusUrl = `${config.publicBaseUrl}/apply.html?tracking=${encodeURIComponent(application.trackingNumber)}`;

  const text = [
    `Hello ${application.firstName},`,
    '',
    `We received your application to join ${application.classLevel} at Wuteve Global Academy.`,
    '',
    `Your tracking number is ${application.trackingNumber}.`,
    '',
    'Keep this number. You can use it at any time to check the status of your',
    'application:',
    statusUrl,
    '',
    'Our admissions team reviews every application by hand and will contact you',
    'using the details you gave us.',
  ].join('\n');

  return {
    to: application.email,
    subject: `We received your application — ${application.trackingNumber}`,
    text,
    html: layout({
      heading: 'Application received',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${escapeHtml(application.firstName)},</p>
        <p style="margin:0 0 16px;">We received your application to join <strong>${escapeHtml(application.classLevel)}</strong> at Wuteve Global Academy.</p>
        <p style="margin:0 0 6px;color:#475569;">Your tracking number</p>
        <p style="margin:0 0 16px;font-size:22px;font-weight:700;letter-spacing:1px;">${escapeHtml(application.trackingNumber)}</p>
        <p style="margin:0 0 16px;">Keep this number. You can use it at any time to check the status of your application.</p>
        <p style="margin:0 0 16px;"><a href="${statusUrl}" style="display:inline-block;padding:12px 20px;background:#1479E8;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:600;">Check my application</a></p>
        <p style="margin:0;color:#475569;">Our admissions team reviews every application by hand and will contact you using the details you gave us.</p>`,
    }),
  };
}

function admissionApprovedEmail({ application }) {
  const statusUrl = `${config.publicBaseUrl}/apply.html?tracking=${encodeURIComponent(application.trackingNumber)}`;
  const note = application.decisionNote ? `\n\nNote from the admissions team:\n${application.decisionNote}` : '';

  const text = [
    `Hello ${application.firstName},`,
    '',
    `Your application to join ${application.classLevel} at Wuteve Global Academy has been approved.`,
    '',
    `Tracking number: ${application.trackingNumber}`,
    '',
    'Our admissions office will contact you on the phone number you provided to',
    'arrange your admission formalities and the start date for your class.',
    note,
    '',
    `You can view this outcome at any time: ${statusUrl}`,
  ].join('\n');

  return {
    to: application.email,
    subject: `Your application is approved — ${application.trackingNumber}`,
    text,
    html: layout({
      heading: 'Your application is approved',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${escapeHtml(application.firstName)},</p>
        <p style="margin:0 0 16px;">Your application to join <strong>${escapeHtml(application.classLevel)}</strong> at Wuteve Global Academy has been <strong>approved</strong>.</p>
        <p style="margin:0 0 6px;color:#475569;">Your tracking number</p>
        <p style="margin:0 0 16px;font-size:22px;font-weight:700;letter-spacing:1px;">${escapeHtml(application.trackingNumber)}</p>
        <p style="margin:0 0 16px;">Our admissions office will contact you on the phone number you provided to arrange your admission formalities and the start date for your class.</p>
        ${application.decisionNote ? `<p style="margin:0 0 16px;padding:12px 14px;background:#f1f5f9;border-radius:10px;"><strong>Note from the admissions team:</strong><br />${escapeHtml(application.decisionNote)}</p>` : ''}
        <p style="margin:0;"><a href="${statusUrl}" style="display:inline-block;padding:12px 20px;background:#1479E8;color:#ffffff;text-decoration:none;border-radius:10px;font-weight:600;">View my application</a></p>`,
    }),
  };
}

function admissionRejectedEmail({ application }) {
  const text = [
    `Hello ${application.firstName},`,
    '',
    `Thank you for applying to join ${application.classLevel} at Wuteve Global Academy.`,
    '',
    'We are not able to offer you a place on this occasion.',
    '',
    `Reason given: ${application.decisionNote || 'Not stated.'}`,
    '',
    `Tracking number: ${application.trackingNumber}`,
    '',
    'You are welcome to apply again for a future intake. If you would like to',
    'discuss this decision, reply to this email and our admissions team will',
    'respond.',
  ].join('\n');

  return {
    to: application.email,
    subject: `About your application — ${application.trackingNumber}`,
    text,
    html: layout({
      heading: 'About your application',
      bodyHtml: `<p style="margin:0 0 12px;">Hello ${escapeHtml(application.firstName)},</p>
        <p style="margin:0 0 16px;">Thank you for applying to join <strong>${escapeHtml(application.classLevel)}</strong> at Wuteve Global Academy. We are not able to offer you a place on this occasion.</p>
        <p style="margin:0 0 16px;padding:12px 14px;background:#f1f5f9;border-radius:10px;"><strong>Reason given:</strong><br />${escapeHtml(application.decisionNote || 'Not stated.')}</p>
        <p style="margin:0 0 16px;">You are welcome to apply again for a future intake. If you would like to discuss this decision, reply to this email and our admissions team will respond.</p>
        <p style="margin:0;color:#475569;">Tracking number: ${escapeHtml(application.trackingNumber)}</p>`,
    }),
  };
}

/**
 * Tell the address an account was moved away from.
 *
 * The security half of an email change: if somebody with a borrowed session moves
 * the account, the real owner finds out, and they still have a working address to
 * recover it from.
 */
function emailAddressChangedEmail({ user, previousEmail }) {
  const text = [
    `Hello ${user.firstName},`,
    '',
    'The email address on your Wuteve Global Academy account was just changed.',
    '',
    `From: ${previousEmail}`,
    `To:   ${user.email}`,
    '',
    'If this was you, nothing more is needed — but confirm the new address from the',
    'link we sent to it, or you will not be able to receive password resets there.',
    '',
    'If this was not you, reply to this message immediately and change your password.',
    'This address will no longer sign in once the change is confirmed.',
  ].join('\n');

  return {
    to: previousEmail,
    subject: 'Your Wuteve account email address was changed',
    text,
    html: layout({
      heading: 'Your email address was changed',
      intro: 'The email address on your Wuteve Global Academy account was just changed.',
      body: `
        <p style="margin:0 0 8px;"><strong>From:</strong> ${escapeHtml(previousEmail)}</p>
        <p style="margin:0 0 16px;"><strong>To:</strong> ${escapeHtml(user.email)}</p>
        <p style="margin:0 0 16px;">If this was you, confirm the new address from the link we sent to it,
        or you will not receive password resets there.</p>
        <p style="margin:0;color:#b42318;"><strong>If this was not you</strong>, reply to this message
        immediately and change your password.</p>`,
    }),
  };
}

/* ------------------------------------------------------------------ *
 * AI credits
 * ------------------------------------------------------------------ */

/** Confirmation that a purchased bundle has been added to the account. */
function aiCreditsAddedEmail({ user, order }) {
  const text = [
    `Hello ${user.firstName},`,
    '',
    `We have received your payment of ${order.amountLabel()} for ${order.credits} AI credits.`,
    '',
    `Reference: ${order.reference}`,
    '',
    'The credits are on your account now. They sit on top of your daily allowance',
    'and do not expire, so they are there whenever you need them.',
    '',
    'Open any lesson and ask the tutor a question, or talk to the career mentor from',
    'your dashboard.',
    '',
    'Thank you for learning with Wuteve Global Academy.',
  ].join('\n');

  return {
    to: user.email,
    subject: `${order.credits} AI credits added to your account`,
    text,
    html: layout({
      heading: 'Your AI credits are ready',
      intro: `We have received your payment of ${order.amountLabel()} for ${order.credits} AI credits.`,
      body: `
        <p style="margin:0 0 16px;">Reference: <strong>${escapeHtml(order.reference)}</strong></p>
        <p style="margin:0 0 16px;">The credits are on your account now. They sit on top of your daily
        allowance and do not expire.</p>
        <p style="margin:0;">Open any lesson and ask the tutor a question, or talk to the career mentor
        from your dashboard.</p>`,
      ctaLabel: 'Open your dashboard',
      ctaUrl: `${config.publicBaseUrl}/student-dashboard.html`,
    }),
  };
}

module.exports = {
  deliver,
  admissionReceivedEmail,
  admissionApprovedEmail,
  admissionRejectedEmail,
  businessEnquiryEmail,
  verificationEmail,
  passwordResetEmail,
  passwordChangedEmail,
  welcomeEmail,
  enrollmentEmail,
  certificateEmail,
  paymentReceiptEmail,
  announcementEmail,
  contactMessageEmail,
  courseCompletedEmail,
  manualPaymentSubmittedEmail,
  manualPaymentRejectedEmail,
  aiCreditsAddedEmail,
  emailAddressChangedEmail,
  cvSubmittedEmail,
  cvApprovedEmail,
  cvRejectedEmail,
  instructorAccountEmail,
  instructorApplicationReceivedEmail,
  instructorApprovedEmail,
  instructorRejectedEmail,
  newsletterWelcomeEmail,
  layout,
  escapeHtml,
};
