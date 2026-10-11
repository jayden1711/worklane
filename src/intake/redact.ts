// Personal data out of a report before anything leaves the coordinator: the
// redacted text is what the intake agent, issues, events and replies ever see.
// Each removal keeps its type ([phone], [email], ...) so a reader knows what was
// there. Over-redaction costs a few words; a miss puts a person's data in an issue.
import { redactString } from '../events/redact.js';

export interface RedactOptions {
  /** Names to remove wherever they appear: the sender's display name, plus project-configured names. */
  names?: string[];
  /** Project-configured patterns, e.g. account or bet ids: each match becomes [custom:<label>]. */
  patterns?: { label: string; regex: string }[];
}

/** Luhn check, for telling card numbers from other long digit runs. */
export function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return digits.length >= 12 && sum % 10 === 0;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function redactPii(text: string, o: RedactOptions = {}): string {
  let s = redactString(text);
  // Emails before phone numbers, so digits inside an address don't become [phone].
  s = s.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]');
  // IBANs: two letters, two digits, then 11-30 alphanumerics (spaces allowed in groups of four).
  s = s.replace(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g, '[account]');
  // Card numbers: 13-19 digits with optional spaces or dashes that pass the Luhn check.
  s = s.replace(/\b\d(?:[ -]?\d){12,18}\b/g, (m) => (luhn(m.replace(/[ -]/g, '')) ? '[card]' : m));
  // Account / routing / member numbers named as such: the value must hold a digit, so "user interface" stays.
  s = s.replace(/\b(acct|account|routing|member|customer|user)(\s*(?:no\.?|number|#|id)?\s*[:#]?\s*)(?=[A-Za-z-]*\d)[A-Za-z0-9-]{4,}/gi, '$1$2[account]');
  // Phone numbers: a run of digits and the usual separators holding 7 to 15 digits (longer runs are not phone
  // numbers; cards were taken above), never an ISO date.
  s = s.replace(/(?<![\w+])(?:\+|\()?\d[\d\s().-]{5,}\d(?![\w])/g, (m) => {
    const n = m.replace(/\D/g, '').length;
    return n >= 7 && n <= 15 && !/^\d{4}-\d{2}-\d{2}$/.test(m.trim()) ? '[phone]' : m;
  });
  for (const name of o.names ?? []) {
    if (name.trim().length < 2) continue;
    s = s.replace(new RegExp(`\\b${escape(name.trim())}\\b`, 'gi'), '[name]');
  }
  for (const p of o.patterns ?? []) {
    // A pattern that doesn't compile is a config error (IntakeConfig refuses it); here it fails closed rather than
    // letting the report through with that data in it.
    s = s.replace(new RegExp(p.regex, 'gi'), `[custom:${p.label}]`);
  }
  return s;
}
