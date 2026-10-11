// SMS source: the provider posts inbound texts to a relay outside the machine
// (relay/), which verifies the provider's signature and keeps only messages
// addressed to the bot. The coordinator pulls them over HTTPS, signing each
// request with a shared secret, and acknowledges what it took. Replies go out
// through the provider's REST API from here; the relay never sends.
import { createHash, createHmac } from 'node:crypto';
import { addressed } from './addressing.js';
import type { IncomingReport } from './report.js';

/** The signature the relay checks: HMAC-SHA256 over timestamp, method, path and the body's SHA-256. */
export function relaySignature(secret: string, ts: string, method: string, path: string, body = ''): string {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', secret).update(`${ts}\n${method}\n${path}\n${bodyHash}`).digest('hex');
}

/** A message as the relay stores it. `conversation` is set for group texts. */
export interface RelayMessage {
  id: string;
  from: string;
  body: string;
  conversation?: string;
  received_at: string;
}

export interface SmsOptions {
  relayUrl: string;
  secret: string;
  prefixes: string[];
  accountSid: string;
  authToken: string;
  /** The bot's own number, as the `From` of 1:1 replies. */
  number: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export class SmsIntake {
  dropped = 0;
  constructor(private o: SmsOptions) {}

  private async signed(method: 'GET' | 'POST', path: string, body = '') {
    const ts = String(Math.floor((this.o.now ?? Date.now)() / 1000));
    const url = new URL(path, this.o.relayUrl);
    return (this.o.fetch ?? fetch)(url, {
      method,
      headers: { 'x-relay-ts': ts, 'x-relay-sig': relaySignature(this.o.secret, ts, method, url.pathname, body), ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body } : {}),
    });
  }

  /** Pull waiting messages, acknowledge them, and return them as reports. Group texts not addressed to the bot are dropped. */
  async pull(): Promise<IncomingReport[]> {
    const r = await this.signed('GET', '/pull');
    if (!r.ok) throw new Error(`relay pull failed: ${r.status}`);
    const { messages } = (await r.json()) as { messages: RelayMessage[] };
    const out: IncomingReport[] = [];
    for (const m of messages ?? []) {
      // The relay already keeps only addressed group messages; check again here, so a misconfigured relay can't widen it.
      const text = m.conversation ? addressed(m.body, this.o.prefixes) : m.body.trim() || null;
      if (!text || !/^\+[1-9]\d{6,14}$/.test(m.from)) {
        this.dropped++;
        continue;
      }
      out.push({
        source: 'sms',
        sourceId: m.id,
        sender: { source: 'sms', id: m.from },
        text,
        receivedAt: m.received_at,
        thread: m.conversation ? { kind: 'group', id: m.conversation } : { kind: 'sms', id: m.from },
      });
    }
    if (messages?.length) {
      const ack = await this.signed('POST', '/ack', JSON.stringify({ ids: messages.map((m) => m.id) }));
      if (!ack.ok) throw new Error(`relay ack failed: ${ack.status}`);
    }
    return out;
  }

  /** Reply to a 1:1 text (Messages API) or into a group (Conversations API). */
  async reply(thread: { kind: 'sms' | 'group'; id: string }, body: string): Promise<boolean> {
    const auth = `Basic ${Buffer.from(`${this.o.accountSid}:${this.o.authToken}`).toString('base64')}`;
    const form = new URLSearchParams(thread.kind === 'group' ? { Body: body.slice(0, 1500) } : { To: thread.id, From: this.o.number, Body: body.slice(0, 1500) });
    const url =
      thread.kind === 'group'
        ? `https://conversations.twilio.com/v1/Conversations/${encodeURIComponent(thread.id)}/Messages`
        : `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.o.accountSid)}/Messages.json`;
    const r = await (this.o.fetch ?? fetch)(url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() });
    return r.ok;
  }
}
