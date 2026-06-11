import { Resend } from "resend";
import { env } from "./env.js";
import { AppError } from "../middleware/error.js";
import { logger } from "./logger.js";

let _resend: Resend | null = null;

function getResendClient(): Resend {
  if (!_resend) {
    const key = env().RESEND_API_KEY;
    if (!key || key === "re_CHANGE_ME") {
      throw new Error("RESEND_API_KEY is not configured — cannot send emails");
    }
    _resend = new Resend(key);
  }
  return _resend;
}

// ---------------------------------------------------------------------------
// Shared branded layout
// ---------------------------------------------------------------------------

/**
 * One layout for every transactional email: Clothedd wordmark, white card on
 * gray, near-black CTA button. Inline CSS only — email clients ignore <style>.
 */
export function renderEmail(opts: {
  heading: string;
  bodyHtml: string;
  ctaText?: string;
  ctaUrl?: string;
  footerNote?: string;
}): string {
  const cta =
    opts.ctaText && opts.ctaUrl
      ? `<a href="${opts.ctaUrl}" style="display:inline-block;margin-top:20px;background:#111827;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 20px;border-radius:8px;">${opts.ctaText}</a>`
      : "";
  const footer = opts.footerNote ?? "You're receiving this because you have a Clothedd account.";

  return `<!DOCTYPE html>
<html lang="en">
<body style="margin:0;padding:0;background-color:#f9fafb;">
  <div style="max-width:480px;margin:0 auto;padding:32px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <div style="font-size:20px;font-weight:700;letter-spacing:-0.02em;color:#111827;margin-bottom:20px;">Clothedd</div>
    <div style="background-color:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
      <h1 style="font-size:18px;font-weight:600;color:#111827;margin:0 0 12px;">${opts.heading}</h1>
      <div style="font-size:14px;line-height:1.6;color:#374151;">${opts.bodyHtml}</div>
      ${cta}
    </div>
    <p style="font-size:12px;color:#9ca3af;margin-top:20px;line-height:1.5;">${footer}</p>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Flow-critical emails — failures surface to the caller (403/503 semantics
// are owned by the route).
// ---------------------------------------------------------------------------

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  const resend = getResendClient();
  const from = env().RESEND_FROM_EMAIL;

  const result = await resend.emails.send({
    from,
    to,
    subject: "Reset your password",
    html: renderEmail({
      heading: "Reset your password",
      bodyHtml: `<p style="margin:0;">You requested a password reset. The link below expires in <strong>1 hour</strong>. If you didn't request this, you can safely ignore this email.</p>`,
      ctaText: "Reset my password",
      ctaUrl: resetUrl,
    }),
  });

  if (result.error) {
    logger.error(
      { resendErrorName: result.error.name, resendErrorMessage: result.error.message },
      "[Resend] email send failed",
    );
    throw new AppError(503, "EMAIL_SEND_FAILED", "Could not send password reset email");
  }
}

export async function sendVerificationEmail(to: string, verifyUrl: string) {
  const resend = getResendClient();
  const from = env().RESEND_FROM_EMAIL;

  const result = await resend.emails.send({
    from,
    to,
    subject: "Confirm your email",
    html: renderEmail({
      heading: "Confirm your email",
      bodyHtml: `<p style="margin:0;">Thanks for signing up! Confirm this email address to secure your account. The link expires in <strong>24 hours</strong>. If you didn't sign up, you can safely ignore this email.</p>`,
      ctaText: "Verify my email",
      ctaUrl: verifyUrl,
    }),
  });

  if (result.error) {
    logger.error(
      { resendErrorName: result.error.name, resendErrorMessage: result.error.message },
      "[Resend] verification email send failed",
    );
    throw new AppError(503, "EMAIL_SEND_FAILED", "Could not send verification email");
  }
}

// ---------------------------------------------------------------------------
// Security / courtesy notices — fire-and-forget. A Resend outage must never
// fail the action that triggered the notice, so these log and swallow.
// ---------------------------------------------------------------------------

async function sendSecurityEmail(to: string, subject: string, html: string): Promise<void> {
  try {
    const resend = getResendClient();
    const result = await resend.emails.send({
      from: env().RESEND_FROM_EMAIL,
      to,
      subject,
      html,
    });
    if (result.error) {
      logger.error(
        { subject, resendErrorName: result.error.name, resendErrorMessage: result.error.message },
        "[Resend] security email send failed",
      );
    }
  } catch (err) {
    logger.error({ err, subject }, "[Resend] security email send failed");
  }
}

export async function sendPasswordChangedEmail(to: string): Promise<void> {
  await sendSecurityEmail(
    to,
    "Your password was changed",
    renderEmail({
      heading: "Your password was changed",
      bodyHtml: `<p style="margin:0 0 10px;">The password for your Clothedd account was just changed, and all other devices were signed out.</p>
<p style="margin:0;"><strong>Wasn't you?</strong> Open the app and use "Forgot password?" right away to take back control of your account.</p>`,
    }),
  );
}

export async function sendWelcomeEmail(to: string, username: string): Promise<void> {
  await sendSecurityEmail(
    to,
    "Welcome to Clothedd",
    renderEmail({
      heading: `Welcome, @${username}`,
      bodyHtml: `<p style="margin:0 0 10px;">Your email is verified and your account is all set.</p>
<p style="margin:0;">Start swiping to teach your feed what you like — the more you swipe, the sharper your recommendations get.</p>`,
      footerNote:
        "You're receiving this one-time email because you verified a new Clothedd account.",
    }),
  );
}

export async function sendSignInMethodAddedEmail(
  to: string,
  provider: "Apple" | "Google",
): Promise<void> {
  await sendSecurityEmail(
    to,
    `Sign in with ${provider} was added to your account`,
    renderEmail({
      heading: `Sign in with ${provider} enabled`,
      bodyHtml: `<p style="margin:0 0 10px;">${provider} sign-in was just linked to your Clothedd account. You can now use it alongside your password.</p>
<p style="margin:0;"><strong>Wasn't you?</strong> Open the app and use "Forgot password?" to reset your password — that signs out every device.</p>`,
    }),
  );
}

export async function sendAccountDeletedEmail(to: string): Promise<void> {
  await sendSecurityEmail(
    to,
    "Your account was deleted",
    renderEmail({
      heading: "Your account was deleted",
      bodyHtml: `<p style="margin:0;">Your Clothedd account and its data have been permanently deleted. We're sorry to see you go — you're always welcome back.</p>`,
      footerNote: "This is the last email you'll receive from Clothedd.",
    }),
  );
}
