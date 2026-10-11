import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedOnce, domainDecision, RefusalTracker, refusedIn, withAllowedHost } from '../src/domain-requests.js';

const use = (id: string, name: string, input: object) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, text: string, err = true) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: err, content: [{ type: 'text', text }] }] } });

test('a WebFetch the guardrails hook refused names its host', () => {
  assert.deepEqual(refusedIn('WebFetch', { url: 'https://docs.example.org/api?x=1' }, '[worklane] docs.example.org is not on the network allowlist; request approval to add it'), [{ host: 'docs.example.org', tool: 'WebFetch', what: 'https://docs.example.org/api?x=1' }]);
  assert.deepEqual(refusedIn('WebFetch', { url: 'https://docs.example.org' }, 'Request failed with status 500'), [], 'another failure is not a network refusal');
});

test('a shell command the sandbox proxy refused names the hosts in it', () => {
  const curl = 'curl -sSf https://api.example.net/v1/items && git clone git@example.com:org/repo.git';
  assert.deepEqual(
    refusedIn('Bash', { command: curl }, 'curl: (56) CONNECT tunnel failed, response 403').map((r) => r.host),
    ['api.example.net', 'example.com'],
  );
  assert.deepEqual(refusedIn('Bash', { command: 'pip install --index-url https://pkgs.example.io/simple x' }, "ProxyError('Cannot connect to proxy.', OSError('Tunnel connection failed: 403 Forbidden'))").map((r) => r.host), ['pkgs.example.io']);
  assert.deepEqual(refusedIn('Bash', { command: 'curl https://api.example.net' }, 'curl: (6) Could not resolve host'), [], 'no proxy refusal, no request');
  assert.deepEqual(refusedIn('Bash', { command: 'npm test' }, 'CONNECT tunnel failed, response 403'), [], 'no host named in the command');
});

test("a run's stream: each refused host once, and never a host the lane already allows", () => {
  const t = new RefusalTracker(['*.allowed.example']);
  t.line(use('1', 'WebFetch', { url: 'https://new.example.org/a' }));
  t.line(result('1', 'new.example.org is not on the network allowlist; request approval to add it'));
  t.line(use('2', 'WebFetch', { url: 'https://new.example.org/b' }));
  t.line(result('2', 'new.example.org is not on the network allowlist; request approval to add it'));
  t.line(use('3', 'Bash', { command: 'curl https://pkg.allowed.example/x https://other.example.com/y' }));
  t.line(result('3', 'curl: (56) CONNECT tunnel failed, response 403'));
  t.line('not json at all');
  assert.deepEqual(t.refused.map((r) => [r.host, r.tool]), [['new.example.org', 'WebFetch'], ['other.example.com', 'Bash']]);
});

test("the owner's decision: three answers, deny recommended, and what each one does", () => {
  const d = domainDecision({ host: 'new.example.org', tool: 'WebFetch', what: 'https://new.example.org/a', issue: 7, role: 'worker', run: 'r1' }, '.worklane/guardrails.yaml');
  assert.equal(d.question, 'Allow agents to reach new.example.org?');
  assert.deepEqual(d.options, ['allow-repo', 'allow-once', 'deny']);
  assert.equal(d.recommendation, 'deny');
  assert.match(d.receipts.join('\n'), /opens a pull request adding new\.example\.org to \.worklane\/guardrails\.yaml network\.allow/);
});

test('"allow-repo" proposes guardrails.yaml with the host added, comments kept; already allowed: nothing', () => {
  const before = 'version: 1\n# hosts agents may reach\nnetwork:\n  allow: [pypi.org] # package index\nrules: []\n';
  const after = withAllowedHost(before, 'new.example.org')!;
  assert.match(after, /# hosts agents may reach/);
  assert.match(after, /pypi\.org/);
  assert.match(after, /new\.example\.org/);
  assert.match(after, /rules: \[\]/);
  assert.equal(withAllowedHost(after, 'new.example.org'), null);
  assert.equal(withAllowedHost('version: 1\nnetwork:\n  allow: ["*.example.org"]\n', 'docs.example.org'), null, 'covered by a wildcard');
  assert.match(withAllowedHost('version: 1\n', 'new.example.org')!, /network:\n {2}allow:\n {4}- new\.example\.org/);
});

test('"allow-once" opens the host for the next run of that task only', () => {
  const ev = [
    { type: 'network.domain_decided', payload: { issue: 7, host: 'a.example.org', answer: 'allow-once' } },
    { type: 'network.domain_decided', payload: { issue: 7, host: 'b.example.org', answer: 'deny' } },
    { type: 'network.domain_decided', payload: { issue: 8, host: 'c.example.org', answer: 'allow-once' } },
  ];
  assert.deepEqual(allowedOnce(ev, 7), ['a.example.org']);
  assert.deepEqual(allowedOnce([...ev, { type: 'run.started', payload: { issue: 7, role: 'worker' } }], 7), [], 'used by the run that started next');
  assert.deepEqual(allowedOnce([...ev, { type: 'run.started', payload: { issue: 7, role: 'evaluator-verdict' } }], 7), ['a.example.org'], 'an evaluator run is not the run it was for');
});
