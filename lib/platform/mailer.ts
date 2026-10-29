/**
 * Platform Mailer
 *
 * Sends sign-in codes over SMTP (SMTP_URL, e.g. smtps://user:pass@smtp.example.com:465,
 * from MAIL_FROM). Without SMTP_URL outside production, codes are logged
 * instead so local development works without a mail server.
 */

import nodemailer, { type Transporter } from 'nodemailer';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!process.env.SMTP_URL) return null;
  transporter ??= nodemailer.createTransport(process.env.SMTP_URL);
  return transporter;
}

export async function sendSignInCode(email: string, code: string): Promise<void> {
  const transport = getTransporter();

  if (!transport) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('SMTP_URL is required to send sign-in codes');
    }
    console.info(`[platform] Sign-in code for ${email}: ${code}`);
    return;
  }

  await transport.sendMail({
    from: process.env.MAIL_FROM || 'no-reply@localhost',
    to: email,
    subject: `Your sign-in code: ${code}`,
    text: `Your sign-in code is ${code}.\n\nIt expires in 10 minutes. If you didn't try to sign in, you can ignore this email.`,
    html: `<p>Your sign-in code is</p><p style="font-size:28px;font-weight:600;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you didn't try to sign in, you can ignore this email.</p>`,
  });
}
