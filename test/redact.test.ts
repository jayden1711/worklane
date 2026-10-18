// The shared redactor (src/events/redact.ts), held to a corpus: every secret shape below comes out redacted, the
// identifiers (emails, internal hosts, private IPs, a home path's user) come out redacted when asked for (and always
// in what the backlog writes to issues, comments and pull requests), and the strings that must survive come out as
// they went in. Every fixture is fake and assembled at runtime, so no secret-, address- or path-shaped literal sits in
// this file for the repo's own scans (gitleaks, the denylist) to find.
import './helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, redactString, REDACTION_PATTERNS, secretKinds, TRACKER } from '../src/events/redact.js';
import { FileBacklog } from '../src/backlog/file.js';
import { GitHubBacklog } from '../src/backlog/github.js';
import { contractKey, parseContract } from '../src/backlog/types.js';
import { budgetFor } from '../src/github/budget.js';

const j = (sep: string, ...parts: string[]) => parts.join(sep);
const fill = (head: string, n: number, c = '0') => head.padEnd(n, c);
const scratch = (p: string) => mkdtempSync(join(tmpdir(), p));

// Secret shapes: fake values in the real formats.
const JWT = j('.', 'eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiJmYWtlLXVzZXIifQ', fill('ZmFrZS1zaWduYXR1cmU', 43, 'x'));
const STRIPE_LIVE = j('_', 'sk', 'live', fill('FAKEfake', 24));
const STRIPE_TEST = j('_', 'sk', 'test', fill('FAKEfake', 24));
const STRIPE_RESTRICTED = j('_', 'rk', 'live', fill('FAKEfake', 24));
const GOOGLE = 'AI' + 'za' + fill('SyFAKE-fake_', 35);
const VALUE = fill('notArealValue', 24, '7');
const HEX_TOKEN = 'abc123'.repeat(7).slice(0, 40);
const json = (k: string, v = VALUE) => JSON.stringify({ id: 3, [k]: v, ok: true });

const SECRETS: [string, string][] = [
  ['a JWT', `Authorization failed for ${JWT} at login`],
  ['a JWT in a cookie', `set-cookie: session=${JWT}; Path=/`],
  ['a Stripe live key', `charging with ${STRIPE_LIVE} now`],
  ['a Stripe test key', `key=${STRIPE_TEST}`],
  ['a Stripe restricted key', `"${STRIPE_RESTRICTED}"`],
  ['a Google API key', `https://maps.example.com/api?key=${GOOGLE}&q=x`],
  ['a JSON "jwt" value', json('jwt')],
  ['a JSON "key" value', json('key')],
  ['a JSON "token" value', json('token')],
  ['a JSON "token" hex value', json('token', HEX_TOKEN)],
  ['a JSON "access_token" value', json('access_token')],
  ['a JSON "secret" value', json('secret')],
  ['a JSON "client_secret" value', json('client_secret')],
  ['a JSON "api_key" value', json('api_key')],
  ['a JSON "apiKey" value', json('apiKey')],
  ['a JSON "password" value', json('password')],
  ['a JSON value in an escaped string', JSON.stringify({ detail: json('token') })],
];

const host = (...labels: string[]) => labels.join('.');
const ip = (...octets: number[]) => octets.join('.');
const USER = 'someone';
const IDENTIFIERS: [string, string, string][] = [
  ['an email', `reported by ${j('@', 'jay.doe+ci', host('mail', 'example', 'org'))} today`, j('@', 'jay.doe+ci', host('mail', 'example', 'org'))],
  ['an email in a sign-off', `Signed-off-by: Some One <${j('@', 'some.one', host('example', 'net'))}>`, j('@', 'some.one', host('example', 'net'))],
  ['a 10/8 address', `connect ECONNREFUSED ${ip(10, 1, 2, 3)}:5432`, ip(10, 1, 2, 3)],
  ['a 172.16/12 address', `upstream ${ip(172, 20, 0, 5)} timed out`, ip(172, 20, 0, 5)],
  ['a 192.168/16 address', `http://${ip(192, 168, 1, 20)}:8080/health`, ip(192, 168, 1, 20)],
  ['a shared-range address', `peer ${ip(100, 101, 102, 103)} left`, ip(100, 101, 102, 103)],
  ['a link-local address', `metadata at ${ip(169, 254, 169, 254)}`, ip(169, 254, 169, 254)],
  ['a unique-local IPv6 address', `bound to ${j(':', 'fd12', '3456', '789a', '', '1')}`, j(':', 'fd12', '3456', '789a', '', '1')],
  ['a link-local IPv6 address', `via ${j(':', 'fe80', '', '1ff', 'fe23', '4567')} on eth0`, j(':', 'fe80', '', '1ff', 'fe23', '4567')],
  ['an .internal host', `dial tcp ${host('db-1', 'prod', 'internal')}:5432`, host('db-1', 'prod', 'internal')],
  ['an mDNS host', `ping ${host('build-box', 'local')} ok`, host('build-box', 'local')],
  ['a cluster-local host', `GET http://${host('api', 'shop', 'svc', 'cluster', 'local')}/v1`, host('api', 'shop', 'svc', 'cluster', 'local')],
  ['a .lan host', `ssh ${host('nas-1', 'lan')} failed`, host('nas-1', 'lan')],
  ['a .corp host', `proxy ${host('gw', 'office', 'corp')} refused`, host('gw', 'office', 'corp')],
  ['a tailnet host', `https://${host('box', 'tail1234', 'ts', 'net')}/`, host('box', 'tail1234', 'ts', 'net')],
  // One-word hosts, and hosts whose first label is also a common variable name.
  ...[
    ['nas', 'lan'], ['vault', 'internal'], ['jira', 'corp'], ['gitlab', 'corp'], ['grafana', 'internal'], ['myapp', 'internal'],
    ['raspberrypi', 'local'], ['homeassistant', 'local'], ['printer', 'home', 'arpa'], ['NAS', 'LAN'],
    ['app', 'internal'], ['app', 'prod', 'internal'], ['data', 'corp'], ['node', 'cluster', 'local'], ['node', 'internal'],
  ].map((l): [string, string, string] => [`the host ${host(...l)}`, `curl http://${host(...l)}/x and ssh ${host(...l)}`, host(...l)]),
  ['a home path', `at Object.<anonymous> (${['', 'home', USER, 'proj', 'src', 'a.ts'].join('/')}:12:3)`, USER],
  ['a macOS home path', `open ${['', 'Users', USER, 'Desktop', 'notes.txt'].join('/')}`, USER],
  ['a WSL home path', `cd ${['', 'mnt', 'c', 'Users', USER, 'proj'].join('/')}`, USER],
  ['a file URL', `at file://${['', 'home', USER, 'proj', 'a.js'].join('/')}:3:1`, USER],
  ['a Windows path', `in ${['C:', 'Users', USER, 'proj', 'a.ts'].join('\\')}`, USER],
];

const SHA = 'a3f1c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2';
const UUID = j('-', '123e4567', 'e89b', '12d3', 'a456', '426614174000');
const MUST_SURVIVE = [
  `merged ${SHA} into main`,
  `0x${SHA}`,
  'Fixes #123, see #7 and PR #640.',
  'The quick brown fox jumps over the lazy dog; the build took 3.2 s and 1/2 of the tests ran.',
  'Edit src/events/redact.ts and docs/design.md, then run npm test.',
  'See https://github.com/owner/repo/pull/12 and https://api.github.com/repos/owner/repo/issues?per_page=100',
  'The dashboard serves /api/events and /runs/12 on localhost:7070 (127.0.0.1).',
  'and/or, either/or, read/write, CI/CD',
  'v1.2.3, 10.2.3, node 22.11.0, react@18.3.1, actions/checkout@v4, @types/node',
  `${j('@', 'git', host('github', 'com'))}:owner/repo.git`,
  `Public DNS at ${ip(8, 8, 8, 8)} and ${ip(1, 1, 1, 1)}.`,
  // A hosted CI runner's home names no one, and the file and line are the evidence.
  'at Object.<anonymous> (/home/runner/work/r/r/test/a.test.ts:42:7)',
  // System paths name no person.
  'config at /etc/shop/app.conf, data in "/var/lib/shop/db", wrote /tmp/build-7/out.log.',
  '- command: /opt/app/bin/check --health',
  '~/.local/share and settings.local.json',
  // JSON that is not a credential.
  'The keybinding is {"key": "ctrl+shift+1"} and {"key": "superfan:issue:123"}; {"token": "short"}',
  '{"key": "ready", "token": null, "secret": false}',
  `{"key": "${UUID}"}`,
  '{"cacheKey": "build-linux-x64-node22", "sortKey": "createdAt2024desc", "primaryKey": "issue_number_644"}',
  '{"oauth": "enabled-for-v2-login", "key": "issue-644-redactor", "token": "intake.triaged.v2"}',
  `const k = ${j('_', 'sk', 'test', 'someLongCamelCaseName')};`,
  // Code is not a host.
  'this.local = true; options.private = false',
  'const v = this.internal; if (opts.corp) return; this.config.internal; someObj.lan; redisCache.internal',
  // Ordinary words: the suffixes on their own, after a missing space, in a relative import and in file names.
  'Keep it internal. Local runs pass; the corp VPN and the lan are fine, and the intranet is down.',
  'Tests passed.Internal review next; it ran.Local too.',
  "import { x } from './util.internal'; import y from '../lib/env.local';",
  'Copy .env.local to settings.local.json and app.local.ts.',
  'eyJ is how base64 JSON starts; sk-live and sk_live are prefixes; AIza too.',
  'Run it at 12:30, the 2026-10-18 build, 3/4 done.',
];

test('every secret shape in the corpus is redacted by default, and secretKinds names it', () => {
  // Every miss is listed, not just the first.
  const missed = SECRETS.filter(([, s]) => {
    const out = redactString(s);
    return [JWT, STRIPE_LIVE, STRIPE_TEST, STRIPE_RESTRICTED, GOOGLE, VALUE, HEX_TOKEN].some((v) => out.includes(v)) || !/REDACTED/.test(out);
  });
  assert.deepEqual(missed.map(([what]) => what), []);
  assert.deepEqual(SECRETS.filter(([, s]) => secretKinds(s).length === 0).map(([what]) => what), [], 'secretKinds names each one');
});

test('a credential key is found by what its name says, not by a list: each family, any prefix, any case', () => {
  const FAMILIES: [string, string[]][] = [
    ['secret', ['aws_secret_access_key', 'AWS_SECRET_ACCESS_KEY', 'stripe_secret_key', 'clientSecret', 'webhook-secret', 'secrets_value']],
    ['password', ['db_password', 'DB_PASSWORD', 'adminPassword', 'smtp-passwd', 'db_pass', 'pwd', 'passphrase']],
    ['token', ['private_token', 'slack_bot_token', 'authToken', 'X-Auth-Token', 'refresh_token', 'jwt', 'bearer']],
    ['api or access key', ['x-api-key', 'openai_api_key', 'OPENAI_API_KEY', 'apiKey', 'ApiKey', 'APIKey', 'apikey', 'access_key', 'privateKey', 'signing-key', 'key']],
    ['authorization and credentials', ['authorization', 'Authorization', 'credentials', 'db_credential', 'auth', 'proxy_auth']],
  ];
  const missed = FAMILIES.flatMap(([family, keys]) =>
    keys.flatMap((k) =>
      [json(k), JSON.stringify({ detail: json(k) })].flatMap((s, i) => (redactString(s).includes(VALUE) || secretKinds(s).length === 0 ? [`${family}: ${k}${i ? ' (escaped)' : ''}`] : [])),
    ),
  );
  assert.deepEqual(missed, []);
  // Names that hold no credential keep their value, however random it looks: no credential word, and a key qualified
  // by a word that names no secret.
  const PLAIN = ['cacheKey', 'cache_key', 'sortKey', 'sort_key', 'primaryKey', 'primary_key', 'idempotency_key', 'partition-key', 'publicKey', 'keyId', 'key_id', 'oauth', 'tokenizer', 'author', 'passive', 'bypass_reason'];
  assert.deepEqual(PLAIN.filter((k) => redactString(json(k)) !== json(k)), []);
});

test('a redacted JSON value keeps its key and the rest of the document', () => {
  assert.equal(redactString(json('jwt')), '{"id":3,"jwt":"[REDACTED]","ok":true}');
  assert.equal(redactString(`{ "Api-Key" : "${VALUE}" }`), '{ "Api-Key" : "[REDACTED]" }');
  assert.deepEqual(JSON.parse(redactString(JSON.stringify({ detail: json('token') }))), { detail: '{"id":3,"token":"[REDACTED]","ok":true}' });
});

test('every identifier in the corpus is redacted when asked for, and left alone by default', () => {
  const missed = IDENTIFIERS.filter(([, s, leak]) => {
    const out = redactString(s, TRACKER);
    return out.includes(leak) || !/\[(email|private-ip|internal-host)\]|~/.test(out);
  });
  assert.deepEqual(missed.map(([what]) => what), []);
  for (const [what, s] of IDENTIFIERS) {
    assert.equal(redactString(s), s, `${what}: the default (event log, secret checks) keeps it`);
    assert.deepEqual(secretKinds(s), [], `${what}: an identifier is not a secret`);
  }
  // What is kept around them: the scheme and port, the host's port.
  assert.equal(redactString(`http://${ip(192, 168, 1, 20)}:8080/health`, TRACKER), 'http://[private-ip]:8080/health');
  assert.equal(redactString(`dial tcp ${host('db-1', 'prod', 'internal')}:5432`, TRACKER), 'dial tcp [internal-host]:5432');
});

test('a home path loses only its user: the file, line and column stay', () => {
  const home = ['', 'home', USER].join('/');
  assert.equal(redactString(`at Object.<anonymous> (${home}/proj/test/a.test.ts:42:7)`, TRACKER), 'at Object.<anonymous> (~/proj/test/a.test.ts:42:7)');
  assert.equal(redactString(`File "${home}/app/main.py", line 12`, TRACKER), 'File "~/app/main.py", line 12');
  assert.equal(redactString(`open ${['', 'Users', USER, 'Desktop', 'notes.txt'].join('/')}.`, TRACKER), 'open ~/Desktop/notes.txt.');
  assert.equal(redactString(`in ${['C:', 'Users', USER, 'proj', 'a.ts'].join('\\')}:3`, TRACKER), 'in ~\\proj\\a.ts:3');
});

test('hex SHAs, issue numbers, prose, repo and system paths, URLs, versions and code survive, in both modes', () => {
  for (const s of MUST_SURVIVE) {
    assert.equal(redactString(s), s);
    assert.equal(redactString(s, TRACKER), s);
  }
  assert.deepEqual(secretKinds(MUST_SURVIVE.join('\n')), []);
});

test('redact() walks objects with the same option', () => {
  const e = j('@', 'a.person', host('example', 'org'));
  const v = { a: [`token ${STRIPE_LIVE}`, e], n: 3, ok: true, nested: { jwt: JWT } };
  assert.deepEqual(redact(v), { a: ['token sk_[REDACTED]', e], n: 3, ok: true, nested: { jwt: '[REDACTED JWT]' } });
  assert.deepEqual(redact(v, TRACKER).a, ['token sk_[REDACTED]', '[email]']);
});

/** An issue body whose done_when contract and research block hold an email, a private IP, an internal host and a home path. */
function contractIssue() {
  const email = j('@', 'ops.person', host('example', 'org'));
  const addr = ip(10, 0, 0, 5);
  const name = host('db-1', 'prod', 'internal');
  const home = ['', 'home', USER].join('/');
  const body = [
    `**Outcome:** reported by ${email} from ${addr}.`,
    '**Deliverable:**',
    '```done_when',
    `- command: ${home}/bin/check --health`,
    `- manual: ${email} confirms the rollout`,
    '- command: |',
    `    curl -fsS http://${addr}:8080/health`,
    `    ping -c1 ${name}`,
    '```',
    '',
    '```research',
    `What does ${name} serve?`,
    '```',
    `Ping ${name} after.`,
  ].join('\n');
  return { body, email, addr, name };
}

test('a done_when contract and a research block are left as written; the text around them is redacted', async () => {
  const { body, email, addr, name } = contractIssue();
  const before = parseContract(body);
  assert.ok(before.ok, JSON.stringify(before));
  const check = (out: string, where: string) => {
    assert.deepEqual(parseContract(out), before, `${where}: the contract parses to the same checks`);
    assert.equal(contractKey(out), contractKey(body), `${where}: the contract's key is unchanged`);
    assert.ok(out.includes(`\`\`\`research\nWhat does ${name} serve?\n\`\`\``), `${where}: the research block is unchanged`);
    assert.match(out, /^\*\*Outcome:\*\* reported by \[email\] from \[private-ip\]\.$/m, `${where}: the outcome is redacted`);
    assert.match(out, /^Ping \[internal-host\] after\.$/m, `${where}: text after the blocks is redacted`);
    assert.ok(!out.split('```')[0]!.includes(email) && !out.split('```')[0]!.includes(addr), where);
  };
  check(redactString(body, TRACKER), 'redactString');
  const f = new FileBacklog(join(scratch('bl-'), 'b.json'), 'harness');
  check((await f.get(await f.createIssue('t', body, []))).body, 'the file backlog');
});

test('only a real fenced block is left as written: a mention of the fence in prose does not switch redaction off', () => {
  const email = j('@', 'ops.person', host('example', 'org'));
  const home = ['', 'home', USER].join('/');
  const leaky = (out: string) => [email, USER, host('db-1', 'prod', 'internal')].filter((l) => out.includes(l));
  for (const fence of ['```done_when', '```research']) {
    // The opener is not followed by a line break, so parseContract and the research parser would not take it.
    const prose = `Not starting: add a ${fence} block.\nLog from ${home}/proj/a.ts:12 by ${email} on ${host('db-1', 'prod', 'internal')}\n\`\`\`\ntrace\n\`\`\``;
    assert.deepEqual(leaky(redactString(prose, TRACKER)), [], `${fence} in prose`);
    assert.deepEqual(leaky(redactString(`See ${fence}x and ${fence}: then ${email}\n\`\`\``, TRACKER)), [], `${fence} glued to a word`);
  }
  // A real block after a prose mention is still kept, and the prose around both is redacted.
  const { body } = contractIssue();
  const mixed = `Say ${'```'}done_when here: ${email}\n${body}`;
  const out = redactString(mixed, TRACKER);
  assert.deepEqual(parseContract(out), parseContract(body));
  assert.ok(out.startsWith('Say ```done_when here: [email]\n'), out.split('\n')[0]);
  // The openers the parsers accept: trailing spaces and a CRLF line break.
  assert.deepEqual(parseContract(redactString(body.replace('```done_when\n', '```done_when  \r\n'), TRACKER)), parseContract(body));
});

test('every pattern runs in linear time on 100 KB of hostile input', () => {
  const N = 100_000;
  const run = (unit: string, head = '', tail = '') => head + unit.repeat(Math.ceil(N / unit.length)) + tail;
  const HOSTILE: [string, string][] = [
    ['eyJ-', run('eyJ-')], ['eyJa', run('eyJa')], ['eyJ.', run('eyJ.')], ['eyJ + run + .', run('a', 'eyJ', '.')],
    ['a.', run('a.')], ['a%', run('a%')], ['a@', run('a@')], ['a-', run('a-')], ['-', run('-')], ['a', run('a')],
    ['/tmp/ + dots', run('.', '/tmp/', 'a')], ['/home/ + a', run('a', '/home/')], ['/home/', run('/home/')], ['file:///home/', run('file:///home/')],
    ['sk_live_', run('sk_live_')], ['sk_live_ + a', run('a', 'sk_live_', '_')], ['AIza', run('AIza')],
    ['"token":"', run('"token":"')], ['escaped "key"', run('\\"key\\":\\"')], ['"key": "a', run('a', '"key": "')],
    ['10.', run('10.')], ['1.', run('1.')], ['fd00:', run('fd00:')], ['C:\\Users\\', run('C:\\Users\\')],
    ['a.lan.', run('a.lan.')], ['x@ + x', run('x', 'x@')], ['x@ + a.', run('a.', 'x@')], ['a + @', run('a', '', '@')],
    ['" + a', run('a', '"')], ['" + a_', run('a_', '"', '":"')], ['"a', run('"a')], ['"x-api-key":"', run('"x-api-key":"')],
    ['"a_b_key": + value', run('a_b_', '"', `key":"${'Aa1'.repeat(6)}"`)], ['//a.lan', run('//a.lan')], ['/a.lan', run('/a.lan')],
    ['a.Internal ', run('a.Internal ')], ['aB.local ', run('aB.local ')], ['this.a.internal', run('a.', 'this.', 'internal')],
  ];
  // The URL-password pattern predates #644 and is quadratic on these shapes too: a follow-up, not this change.
  const KNOWN_SLOW = new Set(['password in a URL']);
  const slow: string[] = [];
  for (const { kind, re, rep } of REDACTION_PATTERNS) {
    if (KNOWN_SLOW.has(kind)) continue;
    for (const [what, s] of HOSTILE) {
      const t0 = performance.now();
      if (typeof rep === 'string') s.replace(re, rep);
      else s.replace(re, rep);
      const ms = performance.now() - t0;
      if (ms > 300) slow.push(`${kind} on ${what}: ${Math.round(ms)} ms`);
    }
  }
  assert.deepEqual(slow, []);
  // The identifier pass's block finder too, on a body of unclosed fences.
  const t0 = performance.now();
  redactString(run('```done_when\n'), TRACKER);
  redactString(run('```research\nx\n```\n'), TRACKER);
  redactString(run('```done_when block '), TRACKER);
  redactString(run('```research  '), TRACKER);
  assert.ok(performance.now() - t0 < 600, 'the machine-block finder is linear');
});

test('what the harness writes to issues, comments and pull requests drops identifiers; a merge commit keeps its sign-off', async () => {
  const leaks = IDENTIFIERS.map(([, , l]) => l);
  const text = `step failed\n${IDENTIFIERS.map(([, s]) => s).join('\n')}\n${SECRETS.map(([, s]) => s).join('\n')}\nend of output`;
  const sent: { url: string; body: string }[] = [];
  const capture = (async (url: string, init?: RequestInit) => {
    sent.push({ url: String(url), body: String(init?.body ?? '') });
    const pulls = String(url).includes('/pulls?');
    return new Response(JSON.stringify(pulls ? [] : { number: 7, html_url: 'https://example.invalid/pr/7', draft: false, node_id: 'x', sha: SHA, merged: true }), { status: 200 });
  }) as typeof fetch;
  // The rate budget on a scratch directory, never the machine's slot directory.
  const slots = scratch('slots-');
  const gh = new GitHubBacklog('o/r', () => 't', capture, undefined, (t) => budgetFor(t, slots));
  await gh.comment(1, text);
  await gh.createIssue(`title at ${leaks[0]}`, text, []);
  await gh.openPr('h', 'main', `title at ${leaks[9]}`, text);
  const posts = sent.filter((s) => s.body);
  assert.equal(posts.length, 3);
  for (const p of posts) {
    for (const l of leaks) assert.ok(!p.body.includes(JSON.stringify(l).slice(1, -1)), `${p.url} still holds ${l}`);
    assert.match(p.body, /step failed[\s\S]*end of output/);
  }
  const signOff = `Signed-off-by: Some One <${j('@', 'some.one', host('example', 'net'))}>`;
  await gh.mergePr(7, SHA, 'Merge pull request #7', `body\n\n${signOff}`);
  assert.ok(sent.at(-1)!.body.includes(JSON.stringify(signOff).slice(1, -1)), 'the merge commit message is not rewritten');

  const f = new FileBacklog(join(scratch('bl-'), 'b.json'), 'harness');
  const n = f.open({ title: 'x', body: '', author: 'a' });
  await f.comment(n, text);
  const pr = await f.openPr('h', 'main', `title at ${leaks[9]}`, text);
  const written = JSON.stringify([await f.comments(n), await f.get(pr.number), await f.get(await f.createIssue(`title at ${leaks[0]}`, text, []))]);
  for (const l of leaks) assert.ok(!written.includes(JSON.stringify(l).slice(1, -1)), `the file backlog still holds ${l}`);
  assert.match(written, /end of output/);
});
