import fs from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { CODE_CAPTURE_DIR, MAIL_FROM, SMTP_HOST, SMTP_PASS, SMTP_PORT, SMTP_USER } from './env-auth';

/**
 * Outgoing mail. One use today: the sign-in code. SMTP, which a Google
 * Workspace mailbox with an app password speaks as is.
 *
 * With CODE_CAPTURE_DIR set, nothing is sent: the message is written to that
 * folder as JSON, for the checks and for a dev machine.
 */

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export async function sendMail(mail: Mail): Promise<void> {
  if (CODE_CAPTURE_DIR) {
    await capture('mail', { to: mail.to, subject: mail.subject, text: mail.text });
    return;
  }
  const transport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  await transport.sendMail({ from: MAIL_FROM, to: mail.to, subject: mail.subject, text: mail.text });
}

/** Written instead of sent. The checks read it back. */
export async function capture(kind: 'mail' | 'sms', message: Record<string, string>): Promise<void> {
  await fs.mkdir(CODE_CAPTURE_DIR, { recursive: true });
  const file = path.join(CODE_CAPTURE_DIR, `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  await fs.writeFile(file, JSON.stringify({ kind, at: new Date().toISOString(), ...message }, null, 2));
}
