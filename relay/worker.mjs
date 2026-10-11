// SMS intake relay: a Cloudflare Worker the owner deploys on their own account.
// The SMS provider (Twilio) posts inbound messages here; the machine running the
// coordinator never accepts an inbound connection, it pulls from this relay.
//
//   POST /twilio  Twilio's webhook (Messages for 1:1 texts, Conversations for group MMS).
//                 Refused unless X-Twilio-Signature verifies with TWILIO_AUTH_TOKEN.
//                 A group message not addressed to the bot (PREFIXES) is dropped
//                 here, unstored. Accepted messages are kept for RETENTION_S at most.
//   GET  /pull    The coordinator takes waiting messages. Signed with RELAY_SECRET.
//   POST /ack     The coordinator acknowledges what it took; those are deleted.
//
// Bindings: KV namespace INTAKE; secrets TWILIO_AUTH_TOKEN and RELAY_SECRET; var
// PREFIXES (a JSON array, default ["bug:"]). Never sends a message itself.

const RETENTION_S = 3 * 86400;
const SKEW_S = 300;
const enc = new TextEncoder();

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function hmac(alg, key, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: alg }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

/** Constant-time string comparison. */
function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Twilio's request signature: HMAC-SHA1 over the full URL plus each POST parameter (sorted by name, name+value), base64. */
export async function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return b64(await hmac('SHA-1', authToken, data));
}

/** The coordinator's signature on /pull and /ack (matches the engine's relaySignature). */
export async function relaySignature(secret, ts, method, path, body = '') {
  const bodyHash = hex(await crypto.subtle.digest('SHA-256', enc.encode(body)));
  return hex(await hmac('SHA-256', secret, `${ts}\n${method}\n${path}\n${bodyHash}`));
}

/** The text without its address, or null if a group message isn't addressed to the bot. */
export function addressedBody(body, prefixes) {
  const t = String(body || '').trimStart();
  for (const p of prefixes) if (t.toLowerCase().startsWith(p.toLowerCase())) return t.slice(p.length).trim() || null;
  return null;
}

const twiml = () => new Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', { headers: { 'content-type': 'text/xml' } });

async function verifyCoordinator(req, env, body) {
  const ts = req.headers.get('x-relay-ts') || '';
  const sig = req.headers.get('x-relay-sig') || '';
  const now = Math.floor(Date.now() / 1000);
  if (!/^\d+$/.test(ts) || Math.abs(now - Number(ts)) > SKEW_S) return false;
  return same(sig, await relaySignature(env.RELAY_SECRET, ts, req.method, new URL(req.url).pathname, body));
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname === '/twilio') {
      const form = new URLSearchParams(await req.text());
      const params = Object.fromEntries(form.entries());
      const expected = await twilioSignature(env.TWILIO_AUTH_TOKEN, req.url, params);
      if (!same(req.headers.get('x-twilio-signature') || '', expected)) return new Response('forbidden', { status: 403 });
      const prefixes = (() => {
        try {
          const p = JSON.parse(env.PREFIXES || '["bug:"]');
          return Array.isArray(p) && p.length ? p.map(String) : ['bug:'];
        } catch {
          return ['bug:'];
        }
      })();
      const conversation = params.ConversationSid || null;
      const from = params.Author || params.From || '';
      const id = params.MessageSid || params.SmsSid || '';
      if (!id || !/^\+[1-9]\d{6,14}$/.test(from)) return twiml();
      // A group message counts only if addressed to the bot; anything else is dropped here and never stored.
      const body = conversation ? addressedBody(params.Body, prefixes) : String(params.Body || '').trim();
      if (!body) return twiml();
      const msg = { id, from, body: conversation ? `${prefixes[0]} ${body}` : body, ...(conversation ? { conversation } : {}), received_at: new Date().toISOString() };
      await env.INTAKE.put(`msg:${id}`, JSON.stringify(msg), { expirationTtl: RETENTION_S });
      return twiml();
    }
    if (req.method === 'GET' && url.pathname === '/pull') {
      if (!(await verifyCoordinator(req, env, ''))) return new Response('forbidden', { status: 403 });
      const list = await env.INTAKE.list({ prefix: 'msg:', limit: 100 });
      const messages = [];
      for (const k of list.keys) {
        const v = await env.INTAKE.get(k.name);
        if (v) messages.push(JSON.parse(v));
      }
      return Response.json({ messages });
    }
    if (req.method === 'POST' && url.pathname === '/ack') {
      const body = await req.text();
      if (!(await verifyCoordinator(req, env, body))) return new Response('forbidden', { status: 403 });
      let ids = [];
      try {
        ids = JSON.parse(body).ids;
      } catch {
        return new Response('bad request', { status: 400 });
      }
      for (const id of Array.isArray(ids) ? ids : []) if (typeof id === 'string' && /^[A-Za-z0-9]{10,64}$/.test(id)) await env.INTAKE.delete(`msg:${id}`);
      return Response.json({ deleted: ids.length });
    }
    return new Response('not found', { status: 404 });
  },
};
