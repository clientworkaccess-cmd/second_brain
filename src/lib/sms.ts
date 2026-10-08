import { CODE_CAPTURE_DIR, GHL_API_KEY, GHL_LOCATION_ID } from './env-auth';
import { capture } from './mail';

/**
 * Text messages through GoHighLevel, which the company already uses. One use
 * today: the sign-in code. The number texted must be a contact of the
 * sub-account; the contact is looked up by number and kept for the process.
 *
 * With CODE_CAPTURE_DIR set, nothing is sent: see mail.ts.
 */

const API = 'https://services.leadconnectorhq.com';
const VERSION = '2021-07-28';
const contacts = new Map<string, string>();

const headers = (): Record<string, string> => ({
  Authorization: `Bearer ${GHL_API_KEY}`,
  Version: VERSION,
  'Content-Type': 'application/json',
  Accept: 'application/json',
});

/** The contact id for a number, found by GoHighLevel's own duplicate check. */
async function contactFor(number: string): Promise<string> {
  const known = contacts.get(number);
  if (known) return known;
  const url = `${API}/contacts/search/duplicate?locationId=${encodeURIComponent(GHL_LOCATION_ID)}&number=${encodeURIComponent(number)}`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) throw new Error(`GoHighLevel refused the contact lookup (${res.status})`);
  const data = (await res.json()) as { contact?: { id?: string } };
  const id = data.contact?.id;
  if (!id) throw new Error('That number is not a contact in GoHighLevel');
  contacts.set(number, id);
  return id;
}

export async function sendSms(to: string, text: string): Promise<void> {
  if (CODE_CAPTURE_DIR) {
    await capture('sms', { to, text });
    return;
  }
  const contactId = await contactFor(to);
  const res = await fetch(`${API}/conversations/messages`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ type: 'SMS', contactId, message: text }),
  });
  if (!res.ok) throw new Error(`GoHighLevel did not take the text (${res.status})`);
}
