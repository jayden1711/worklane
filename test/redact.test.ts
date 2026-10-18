// The shared redactor (src/events/redact.ts), held to a corpus: every secret shape below comes out redacted, the
// identifiers (emails, internal hosts, private IPs, absolute paths) come out redacted when asked for (and always in
// what the backlog writes to issues, comments and pull requests), and the strings that must survive come out as they
// went in. Every fixture is fake and assembled at runtime, so no secret-, address- or path-shaped literal sits in this
// file for the repo's own scans (gitleaks, the denylist) to find.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { redact, redactString, secretKinds } from '../src/events/redact.js';
import { FileBacklog } from '../src/backlog/file.js';
import { GitHubBacklog } from '../src/backlog/github.js';

const j = (sep: string, ...parts: string[]) => parts.join(sep);
const fill = (head: string, n: number, c = '0') => head.padEnd(n, c);

// Secret shapes: fake values in the real formats.
const JWT = j('.', 'eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiJmYWtlLXVzZXIifQ', fill('ZmFrZS1zaWduYXR1cmU', 43, 'x'));
const STRIPE_LIVE = j('_', 'sk', 'live', fill('FAKEfake', 24));
const STRIPE_TEST = j('_', 'sk', 'test', fill('FAKEfake', 24));
const STRIPE_RESTRICTED = j('_', 'rk', 'live', fill('FAKEfake', 24));
const GOOGLE = 'AI' + 'za' + fill('SyFAKE-fake_', 35);
const VALUE = fill('notArealValue', 24, '7');
const json = (k: string) => JSON.stringify({ id: 3, [k]: VALUE, ok: true });

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
const IDENTIFIERS: [string, string, string][] = [
  ['an email', `reported by ${j('@', 'jay.doe+ci', host('mail', 'example', 'org'))} today`, j('@', 'jay.doe+ci', host('mail', 'example', 'org'))],
  ['an email in a sign-off', `Signed-off-by: Some One <${j('@', 'some.one', host('example', 'net'))}>`, j('@', 'some.one', host('example', 'net'))],
  ['a 10/8 address', `connect ECONNREFUSED ${ip(10, 1, 2, 3)}:5432`, ip(10, 1, 2, 3)],
  ['a 172.16/12 address', `upstream ${ip(172, 20, 0, 5)} timed out`, ip(172, 20, 0, 5)],
  ['a 192.168/16 address', `http://${ip(192, 168, 1, 20)}:8080/health`, ip(192, 168, 1, 20)],
  ['a shared-range address', `peer ${ip(100, 101, 102, 103)} left`, ip(100, 101, 102, 103)],
  ['a link-local address', `metadata at ${ip(169, 254, 169, 254)}`, ip(169, 254, 169, 254)],
  ['a unique-local IPv6 address', `bound to ${j(':', 'fd12', '3456', '789a', '', '1')}`, j(':', 'fd12', '3456', '789a', '', '1')],
  ['an .internal host', `dial tcp ${host('db-1', 'prod', 'internal')}:5432`, host('db-1', 'prod', 'internal')],
  ['an mDNS host', `ping ${host('build-box', 'local')} ok`, host('build-box', 'local')],
  ['a cluster-local host',`GET http://${host('api', 'shop', 'svc', 'cluster', 'local')}/v1`, host('api', 'shop', 'svc', 'cluster', 'local')],
  ['a .lan host', `ssh ${host('nas', 'lan')} failed`, host('nas', 'lan')],
  ['a .corp host', `proxy ${host('gw', 'corp')} refused`, host('gw', 'corp')],
  ['a tailnet host', `https://${host('box', 'tail1234', 'ts', 'net')}/`, host('box', 'tail1234', 'ts', 'net')],
  ['a home path', `at Object.<anonymous> (${['', 'home', 'someone', 'proj', 'src', 'a.ts'].join('/')}:12:3)`, ['', 'home', 'someone'].join('/')],
  ['a macOS home path', `open ${['', 'Users', 'someone', 'Desktop', 'notes.txt'].join('/')}`, ['', 'Users', 'someone'].join('/')],
  ['a temp path', `wrote ${['', 'tmp', 'build-7', 'out.log'].join('/')}.`, ['', 'tmp', 'build-7'].join('/')],
  ['a system path', `config at ${['', 'etc', 'shop', 'app.conf'].join('/')}`, ['', 'etc', 'shop'].join('/')],
  ['a var path', `"${['', 'var', 'lib', 'shop', 'db'].join('/')}"`, ['', 'var', 'lib', 'shop'].join('/')],
  ['a Windows path', `in ${['C:', 'Users', 'someone', 'proj', 'a.ts'].join('\\')}`, ['C:', 'Users', 'someone'].join('\\')],
];

const SHA = 'a3f1c9e0b2d4f6a8c0e2b4d6f8a0c2e4b6d8f0a2';
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
  'The keybinding is {"key": "ctrl+shift+1"} and {"key": "superfan:issue:123"}; {"token": "short"}',
  '{"key": "ready", "token": null, "secret": false}',
  'this.local = true; options.private = false',
  'eyJ is how base64 JSON starts; sk-live and sk_live are prefixes; AIza too.',
  'Run it at 12:30, the 2026-10-18 build, 3/4 done.',
];

test('every secret shape in the corpus is redacted by default, and secretKinds names it', () => {
  // Every miss is listed, not just the first.
  const missed = SECRETS.filter(([, s]) => {
    const out = redactString(s);
    return [JWT, STRIPE_LIVE, STRIPE_TEST, STRIPE_RESTRICTED, GOOGLE, VALUE].some((v) => out.includes(v)) || !/REDACTED/.test(out);
  });
  assert.deepEqual(missed.map(([what]) => what), []);
  assert.deepEqual(SECRETS.filter(([, s]) => secretKinds(s).length === 0).map(([what]) => what), [], 'secretKinds names each one');
});

test('a redacted JSON value keeps its key and the rest of the document', () => {
  assert.equal(redactString(json('jwt')), '{"id":3,"jwt":"[REDACTED]","ok":true}');
  assert.equal(redactString(`{ "Api-Key" : "${VALUE}" }`), '{ "Api-Key" : "[REDACTED]" }');
  assert.deepEqual(JSON.parse(redactString(JSON.stringify({ detail: json('token') }))), { detail: '{"id":3,"token":"[REDACTED]","ok":true}' });
});

test('every identifier in the corpus is redacted when asked for, and left alone by default', () => {
  const missed = IDENTIFIERS.filter(([, s, leak]) => {
    const out = redactString(s, { identifiers: true });
    return out.includes(leak) || !/\[(email|private-ip|internal-host|path)\]/.test(out);
  });
  assert.deepEqual(missed.map(([what]) => what), []);
  for (const [what, s] of IDENTIFIERS) {
    assert.equal(redactString(s), s, `${what}: the default (event log, secret checks) keeps it`);
    assert.deepEqual(secretKinds(s), [], `${what}: an identifier is not a secret`);
  }
  // What is kept around them: the scheme and port, the file's line, the sentence's full stop.
  assert.equal(redactString(`http://${ip(192, 168, 1, 20)}:8080/health`, { identifiers: true }), 'http://[private-ip]:8080/health');
  assert.equal(redactString(`wrote ${['', 'tmp', 'build-7', 'out.log'].join('/')}.`, { identifiers: true }), 'wrote [path].');
  assert.equal(redactString(`dial tcp ${host('db-1', 'prod', 'internal')}:5432`, { identifiers: true }), 'dial tcp [internal-host]:5432');
});

test('hex SHAs, issue numbers, prose, repo paths, URLs and versions survive, in both modes', () => {
  for (const s of MUST_SURVIVE) {
    assert.equal(redactString(s), s);
    assert.equal(redactString(s, { identifiers: true }), s);
  }
  assert.deepEqual(secretKinds(MUST_SURVIVE.join('\n')), []);
});

test('redact() walks objects with the same option', () => {
  const e = j('@', 'a.person', host('example', 'org'));
  const v = { a: [`token ${STRIPE_LIVE}`, e], n: 3, ok: true, nested: { jwt: JWT } };
  assert.deepEqual(redact(v), { a: ['token sk_[REDACTED]', e], n: 3, ok: true, nested: { jwt: '[REDACTED JWT]' } });
  assert.deepEqual(redact(v, { identifiers: true }).a, ['token sk_[REDACTED]', '[email]']);
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
  const gh = new GitHubBacklog('o/r', () => 't', capture);
  await gh.comment(1, text);
  await gh.createIssue(`title at ${leaks[0]}`, text, []);
  await gh.openPr('h', 'main', `title at ${leaks[8]}`, text);
  const posts = sent.filter((s) => s.body);
  assert.equal(posts.length, 3);
  for (const p of posts) {
    for (const l of leaks) assert.ok(!p.body.includes(JSON.stringify(l).slice(1, -1)), `${p.url} still holds ${l}`);
    assert.match(p.body, /step failed[\s\S]*end of output/);
  }
  const signOff = `Signed-off-by: Some One <${j('@', 'some.one', host('example', 'net'))}>`;
  await gh.mergePr(7, SHA, 'Merge pull request #7', `body\n\n${signOff}`);
  assert.ok(sent.at(-1)!.body.includes(JSON.stringify(signOff).slice(1, -1)), 'the merge commit message is not rewritten');

  const f = new FileBacklog(join(mkdtempSync(join(tmpdir(), 'bl-')), 'b.json'), 'harness');
  const n = f.open({ title: 'x', body: '', author: 'a' });
  await f.comment(n, text);
  const pr = await f.openPr('h', 'main', `title at ${leaks[8]}`, text);
  const written = JSON.stringify([await f.comments(n), await f.get(pr.number), await f.get(await f.createIssue(`title at ${leaks[0]}`, text, []))]);
  for (const l of leaks) assert.ok(!written.includes(JSON.stringify(l).slice(1, -1)), `the file backlog still holds ${l}`);
  assert.match(written, /end of output/);
});
