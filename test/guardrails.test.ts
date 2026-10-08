import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuardrailsConfig } from '../src/config/schema.js';
import { checkGuardrails, exampleContext } from '../src/guardrails/check.js';
import { evaluate } from '../src/guardrails/engine.js';
import { fingerprint } from '../src/guardrails/fingerprint.js';

const PROD = 'postgres://app:prod-pw@db.internal:5432/app';
const STAGING = 'postgres://app:staging-pw@db.internal:5432/app';

// A generic project whose staging and production databases share host, port,
// database and user, deployed with a platform CLI that has a "linked" environment.
const cfg = GuardrailsConfig.parse({
  version: 1,
  rules: [
    {
      id: 'prod-shell',
      action: 'block',
      reason: 'no production shells',
      match: { cli_env: { cli: 'railway', subcommands: ['run', 'ssh', 'connect', 'shell'], environments: ['production'], resolver: 'railway' } },
    },
    {
      id: 'prod-vars-set',
      action: 'ask',
      reason: 'setting production variables needs a human',
      match: { cli_env: { cli: 'railway', subcommands: ['variables', 'variable'], flags_any: ['--set', '-s'], environments: ['production'], resolver: 'railway' } },
    },
    { id: 'prod-db', action: 'block', reason: 'production database', match: { connection: { fingerprints: 'prod-db' } } },
  ],
  fingerprints: { 'prod-db': { command: 'true', key: 'DATABASE_URL' } },
  protected_paths: ['.worklane/**', '.claude/settings.json'],
  network: { allow: ['docs.github.com', '*.npmjs.org'] },
  examples: {
    fingerprints: { 'prod-db': [PROD] },
    linked_environments: { '.': 'production', 'staging-checkout': 'staging' },
    must_block: [
      { bash: 'railway run --environment production node scripts/migrate.js' },
      { bash: 'railway ssh' },
      { bash: `psql ${PROD} -c 'delete from t'` },
    ],
    must_ask: [{ bash: 'railway variables --environment production --set A=1' }],
    must_allow: [
      { bash: 'railway variables --environment staging --set A=1' },
      { bash: 'railway logs --environment production' },
      { bash: `psql ${STAGING} -c 'select 1'` },
      { bash: 'railway ssh', cwd: 'staging-checkout' },
      { tool: 'Edit', path: 'src/payments/ledger.js' },
    ],
  },
});

const ctx = (agent = true) => exampleContext(cfg, '/p', agent);
const bash = (command: string, cwd = '/p', agent = true) => evaluate({ tool: 'Bash', input: { command }, cwd }, cfg, ctx(agent)).decision;

test('fingerprints differ when only the password differs, and ignore spelling differences', () => {
  assert.notEqual(fingerprint(PROD), fingerprint(STAGING));
  assert.equal(fingerprint(PROD), fingerprint('postgresql://app:prod-pw@DB.internal/app'));
  assert.equal(fingerprint('https://x'), null);
});

test('production shell via the platform CLI is blocked, by flag, link, or when the environment is unknown', () => {
  assert.equal(bash('railway run --environment production node x.js'), 'deny');
  assert.equal(bash('railway run -e production node x.js'), 'deny');
  assert.equal(bash('railway run --environment=production node x.js'), 'deny');
  assert.equal(bash('railway ssh'), 'deny', 'linked to production');
  assert.equal(bash('railway ssh', '/p/staging-checkout'), 'none', 'linked to staging');
  assert.equal(bash('railway ssh', '/elsewhere'), 'deny', 'unresolved environment counts as production');
  assert.equal(bash(`bash -c 'cd x && railway connect --environment production'`), 'deny');
  assert.equal(bash('railway logs --environment production'), 'none', 'reading production stays allowed');
});

test('prod database blocked by connection fingerprint, including through env vars; staging allowed', () => {
  assert.equal(bash(`psql "${PROD}" -c 'update t set x=1'`), 'deny');
  assert.equal(bash(`DATABASE_URL='${PROD}' node scripts/fix.js`), 'deny');
  assert.equal(bash(`psql ${STAGING}`), 'none');
  const withEnv = { ...ctx(), env: { DATABASE_URL: PROD } };
  assert.equal(evaluate({ tool: 'Bash', input: { command: 'psql $DATABASE_URL' }, cwd: '/p' }, cfg, withEnv).decision, 'deny');
  // If production fingerprints were never fetched, any DB URL is treated as production.
  const unknown = { ...ctx(), fingerprints: {} };
  assert.equal(evaluate({ tool: 'Bash', input: { command: `psql ${STAGING}` }, cwd: '/p' }, cfg, unknown).decision, 'deny');
});

test('setting production variables asks; staging is frictionless', () => {
  assert.equal(bash('railway variables --environment production --set A=1'), 'ask');
  assert.equal(bash('railway variables --environment staging --set A=1'), 'none');
});

test('protected harness files: agents denied (including shell redirects); humans unaffected', () => {
  const edit = (path: string, agent: boolean) => evaluate({ tool: 'Edit', input: { file_path: `/p/${path}` }, cwd: '/p' }, cfg, ctx(agent)).decision;
  assert.equal(edit('.worklane/guardrails.yaml', true), 'deny');
  assert.equal(edit('.worklane/guardrails.yaml', false), 'none');
  assert.equal(edit('src/payments/ledger.js', true), 'none', 'money-path code stays editable');
  assert.equal(bash('echo x > .claude/settings.json'), 'deny');
  assert.equal(bash('echo x | tee .worklane/a.yaml'), 'deny');
  assert.equal(bash('echo x > .claude/settings.json', '/p', false), 'none');
});

test('secret files: agents may not read them by tool or shell; exclusions apply; humans unaffected', () => {
  const withSecrets = GuardrailsConfig.parse({ ...cfg, secret_paths: ['./.env', './.env.*', '!./.env.example', '~/.railway/**'] });
  const c = (agent: boolean) => ({ ...exampleContext(withSecrets, '/p', agent), home: '/home/u' });
  const read = (path: string, agent = true) => evaluate({ tool: 'Read', input: { file_path: path }, cwd: '/p' }, withSecrets, c(agent)).decision;
  const sh = (command: string, agent = true) => evaluate({ tool: 'Bash', input: { command }, cwd: '/p' }, withSecrets, c(agent)).decision;
  assert.equal(read('/p/.env'), 'deny');
  assert.equal(read('/p/.env.production'), 'deny');
  assert.equal(read('/p/.env.example'), 'none');
  assert.equal(read('/home/u/.railway/config.json'), 'deny');
  assert.equal(sh('cat .env'), 'deny');
  assert.equal(sh('grep TOKEN ~/.railway/config.json'), 'deny');
  assert.equal(sh('cat README.md'), 'none');
  assert.equal(read('/p/.env', false), 'none', 'humans may read their own .env');
  assert.equal(sh('railway run --environment production node x.js', false), 'deny', 'dangerous-action blocks apply to humans too');
});

test('agents can only fetch allowlisted domains', () => {
  const fetch = (url: string, agent = true) => evaluate({ tool: 'WebFetch', input: { url }, cwd: '/p' }, cfg, ctx(agent)).decision;
  assert.equal(fetch('https://docs.github.com/en'), 'none');
  assert.equal(fetch('https://registry.npmjs.org/x'), 'none');
  assert.equal(fetch('https://evil.example/x'), 'deny');
  assert.equal(fetch('https://evil.example/x', false), 'none', 'humans keep the normal prompt');
});

test('guardrails check passes a consistent rule set', () => {
  assert.deepEqual(checkGuardrails(cfg, '/p'), []);
});

test('guardrails check catches a new rule that conflicts with a must-allow example', () => {
  const conflicting = GuardrailsConfig.parse({
    ...cfg,
    rules: [...cfg.rules, { id: 'no-money-edits', action: 'block', reason: 'too broad', match: { path: { globs: ['src/payments/**'] } } }],
  });
  const problems = checkGuardrails(conflicting, '/p');
  assert.ok(problems.some((p) => p.kind === 'expected_allow' && p.rule === 'no-money-edits'), JSON.stringify(problems));
});

test('guardrails check flags a rule no example exercises', () => {
  const untested = GuardrailsConfig.parse({
    ...cfg,
    rules: [...cfg.rules, { id: 'never-fires', action: 'block', reason: 'x', match: { command: { pattern: '^nothing-matches-this$' } } }],
  });
  assert.ok(checkGuardrails(untested, '/p').some((p) => p.kind === 'untested_rule' && p.rule === 'never-fires'));
});
