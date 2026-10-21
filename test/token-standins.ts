// Stand-ins for every credential shape the shared redactor (src/events/redact.ts) knows, one or more per kind (#889).
// Fake values in the real formats, assembled at run time so no token-shaped literal is committed. Used by
// test/redact-shapes.test.ts (each shape through each output path) and test/redaction-one-module.test.ts (no regex
// outside the shared redactor rewrites one of them).
//
// Each entry: the kind the shared redactor names it by (secretKinds), the text as it would appear, and the part of it
// that must never survive. `token` false: a structure around a value (a password in a URL, a value under a JSON key),
// not a token's own shape; the one-module lint reads only token shapes, since a broad rule elsewhere (an email
// pattern) may match a structure's text without being a token redactor.

/** `seed` repeated and cut to `n` characters: mixed case with digits, like a random key. */
export const run = (n: number, seed = 'A1b2C3d4E5f6G7h8') => seed.repeat(Math.ceil(n / seed.length)).slice(0, n);
const hex = (n: number) => '7e9b5d3c1f0a2468'.repeat(Math.ceil(n / 16)).slice(0, n);
const j = (sep: string, ...parts: string[]) => parts.join(sep);
const upper = (n: number) => 'Q7RZ4KX2M9TB'.repeat(Math.ceil(n / 12)).slice(0, n);

export interface StandIn {
  /** The kind src/events/redact.ts names it by (secretKinds). */
  kind: string;
  /** A short name for the test output. */
  what: string;
  /** The text as it would appear in a log line. */
  value: string;
  /** What must not survive redaction (the secret part of `value`). */
  secret: string;
  /** A token's own shape (true), or a structure around a value (false). */
  token: boolean;
  /**
   * Ordinary text of the same structure (a link, for a URL-shaped token), with an ordinary `part` where the secret is:
   * a regex that takes that part in too handles the structure (every link, every path), not this token's shape.
   */
  control?: { text: string; part: string };
}

const t = (kind: string, what: string, value: string, secret = value, control?: StandIn['control']): StandIn => ({ kind, what, value, secret, token: true, ...(control ? { control } : {}) });

const DISCORD = j('.', `MTAx${'MjM0NTY3ODkw'.repeat(2)}`, 'GhIjKl', `${'abcdefghij'.repeat(3)}AB`);
const DISCORD_NEW = j('.', `MTI${run(23, 'k5ODc2NTQzMjEw')}`, 'G7xQ_p', run(38));
const PEM_BODY = run(64);
const PEM = j('\n', j(' ', '-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'), PEM_BODY, j(' ', '-----END', 'RSA', 'PRIVATE', 'KEY-----'));
const URL_PASSWORD = run(24, 'pW9xQ2zL');
const JSON_VALUE = run(24, 'notArealValue7');
/** HTTP Basic: base64 of user:password (git's extraheader form, with an App installation token as the password). */
const BASIC = Buffer.from(`x-access-token:${j('_', 'ghs', run(36))}`).toString('base64');

/** Every stand-in: a shape gone from here is a shape no test drives (registered never-shrink). */
// check-table: never-shrink
export const SHAPES: readonly StandIn[] = [
  // GitHub: classic, OAuth, user-to-server, installation and refresh tokens, and fine-grained PATs.
  t('GitHub token', 'a GitHub classic token', `ghp_${run(36)}`),
  t('GitHub token', 'a GitHub OAuth token', `gho_${run(36)}`),
  t('GitHub token', 'a GitHub user-to-server token', `ghu_${run(36)}`),
  t('GitHub token', 'a GitHub App installation token', `ghs_${run(36)}`),
  t('GitHub token', 'a GitHub refresh token', `ghr_${run(36)}`),
  t('GitHub token', 'a GitHub fine-grained token', `github_pat_11${run(20)}_${run(59)}`),
  // Anthropic: API, setup-token (OAuth) and admin keys.
  t('API key (sk-)', 'an Anthropic API key', `sk-ant-api03-${run(93)}AA`),
  t('API key (sk-)', 'an Anthropic setup token', `sk-ant-oat01-${run(80)}AA`),
  t('API key (sk-)', 'an Anthropic admin key', `sk-ant-admin01-${run(80)}AA`),
  // A plain `sk-` key (an OpenAI-style project key): no distinctive prefix, so found glued only from a glue point (#889 round 8).
  t('API key (sk-)', 'a plain sk- project key', `sk-proj-${run(48)}`),
  // Discord: a bot token (three base64url parts), older and newer first-part lengths.
  t('Discord bot token', 'a Discord bot token', DISCORD),
  t('Discord bot token', 'a newer Discord bot token', DISCORD_NEW),
  // Slack: bot, user, legacy, refresh and rotation tokens, the app-level token and an incoming webhook.
  t('Slack token', 'a Slack bot token', `xoxb-${j('-', '123456789012', '1234567890123', run(24))}`),
  t('Slack token', 'a Slack user token', `xoxp-${j('-', '123456789012', '1234567890123', '1234567890123', hex(32))}`),
  t('Slack token', 'a Slack workspace token', `xoxa-2-${run(40)}`),
  t('Slack token', 'a Slack refresh token', `xoxr-${run(40)}`),
  t('Slack token', 'a Slack legacy token', `xoxs-${run(40)}`),
  t('Slack token', 'a Slack rotation token', `xoxe.xoxb-1-${run(140)}`),
  t('Slack token', 'a Slack rotation refresh token', `xoxe-1-${run(140)}`),
  t('Slack app-level token', 'a Slack app-level token', `xapp-${j('-', '1', 'A0123456789', '1234567890123', hex(64))}`),
  t('Slack webhook', 'a Slack webhook', `https://hooks.slack.com/services/T0${upper(8)}/B0${upper(8)}/${run(24)}`, `${run(24)}`, { text: 'https://docs.example.test/services/team/guides/getting-started-page', part: 'getting-started-page' }),
  // Linear: a personal API key and an OAuth token.
  t('Linear key', 'a Linear API key', `lin_api_${run(40)}`),
  t('Linear key', 'a Linear OAuth token', `lin_oauth_${run(64)}`),
  // Tailscale: an auth key, an API access token and an OAuth client secret.
  t('Tailscale key', 'a Tailscale auth key', `tskey-auth-k${upper(10)}CNTRL-${run(33)}`),
  t('Tailscale key', 'a Tailscale API token', `tskey-api-k${upper(10)}CNTRL-${run(33)}`),
  t('Tailscale key', 'a Tailscale client secret', `tskey-client-k${upper(10)}CNTRL-${run(33)}`),
  // A dashboard key (#889: prefixed, so it is found standing alone), with a `-` and a `_` as base64url has. The prefix
  // is written out: keys already issued carry it, so changing it is a change this list must see.
  t('dashboard key', 'a dashboard key', `${j('_', 'wld', run(30, 'kQ9-zX_7mP2v'))}Ab`),
  // The rest of the shapes the shared redactor knows.
  t('Stripe key', 'a Stripe live key', j('_', 'sk', 'live', run(24))),
  t('Stripe key', 'a Stripe restricted key', j('_', 'rk', 'live', run(24))),
  t('Google API key', 'a Google API key', `AI${'za'}${run(35, 'SyFAKE-fake_9')}`),
  t('JWT', 'a JWT', j('.', `eyJ${'hbGciOiJIUzI1NiJ9'}`, `eyJ${'zdWIiOiJmYWtlLXVzZXIifQ'}`, run(43))),
  t('AWS access key', 'an AWS access key id', `AKIA${upper(16)}`),
  t('AWS access key', 'an AWS temporary key id', `ASIA${upper(16)}`),
  t('private key', 'a PEM private key', PEM, PEM_BODY),
  t('bearer token', 'a bearer token', `Bearer ${run(40, 'zY8xW7vU6')}`, run(40, 'zY8xW7vU6')),
  t('Basic credential', 'a Basic credential', `Basic ${BASIC}`, BASIC),
  t('32-byte hex key', 'a 32-byte hex key', `0x${hex(64)}`),
  // Structures around a value, not token shapes.
  { kind: 'password in a URL', what: 'a password in a URL', value: `postgres://app:${URL_PASSWORD}@db.example.test:5432/app`, secret: URL_PASSWORD, token: false },
  { kind: 'secret under a JSON key', what: 'a value under a JSON key', value: JSON.stringify({ id: 3, client_secret: JSON_VALUE }), secret: JSON_VALUE, token: false },
];

/** Whether any 12-character piece of `secret` is still in `out`: a pattern that stops early leaks the rest. */
export function leaks(out: string, secret: string, piece = 12): boolean {
  if (secret.length <= piece) return out.includes(secret);
  for (let i = 0; i + piece <= secret.length; i++) if (out.includes(secret.slice(i, i + piece))) return true;
  return false;
}
