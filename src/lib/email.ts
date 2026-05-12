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

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  const resend = getResendClient();
  const from = env().RESEND_FROM_EMAIL;

  const result = await resend.emails.send({
    from,
    to,
    subject: "Reset your password",
    html: `
      <h2>Password Reset</h2>
      <p>You requested a password reset. Click the link below to set a new password:</p>
      <p><a href="${resetUrl}">Reset my password</a></p>
      <p>This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
    `,
  });

  if (result.error) {
    logger.error(
      { resendErrorName: result.error.name, resendErrorMessage: result.error.message },
      "[Resend] email send failed"
    );
    throw new AppError(503, "EMAIL_SEND_FAILED", "Could not send password reset email");
  }
}
