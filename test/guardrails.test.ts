import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BRAND } from '../src/brand.js';
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

test('regression: everything under .claude/ and the config folder is protected for agents, whatever the project lists', () => {
  // A project whose guardrails protect nothing: the built-in harness paths still apply.
  const bare = GuardrailsConfig.parse({ version: 1, rules: [], protected_paths: [], examples: { must_block: [], must_ask: [], must_allow: [] } });
  const c = (agent = true) => exampleContext(bare, '/p', agent);
  const tool = (t: string, path: string, agent = true) => evaluate({ tool: t, input: { file_path: `/p/${path}` }, cwd: '/p' }, bare, c(agent)).decision;
  const sh = (command: string, agent = true) => evaluate({ tool: 'Bash', input: { command }, cwd: '/p' }, bare, c(agent)).decision;
  assert.equal(tool('Edit', '.claude/settings.json'), 'deny');
  assert.equal(tool('Write', '.claude/x.json'), 'deny', 'a new file under .claude/ too');
  assert.equal(tool('MultiEdit', '.claude/skills/a/SKILL.md'), 'deny');
  assert.equal(tool('Write', '.worklane/tests.yaml'), 'deny');
  for (const command of [
    'echo {} > .claude/x.json',
    'printf x | tee -a .claude/settings.json',
    'cp /tmp/s.json .claude/settings.json',
    'cp /tmp/x.json .claude',
    'mv /tmp/s.json .claude/settings.local.json',
    'mv .claude/settings.json /tmp/old.json',
    "sed -i 's/true/false/' .claude/settings.json",
    "perl -pi -e 's/a/b/' .claude/settings.json",
    'rm -rf .claude',
    'touch .claude/x.json',
    'mkdir -p .claude/hooks',
    'ln -s /tmp/evil.json .claude/settings.json',
    'dd if=/tmp/x of=.claude/settings.json',
    "bash -c 'cp /tmp/x .worklane/review.yaml'",
  ]) assert.equal(sh(command), 'deny', command);
  // Reading them, writing elsewhere, and people's own sessions are unaffected.
  assert.equal(sh('cat .claude/settings.json'), 'none');
  assert.equal(sh('cp .claude/settings.json /tmp/copy.json'), 'none');
  assert.equal(sh("sed -n '1p' .claude/settings.json"), 'none');
  assert.equal(tool('Edit', 'src/a.ts'), 'none');
  assert.equal(tool('Edit', '.claude/settings.json', false), 'none');
  assert.equal(sh('echo {} > .claude/x.json', false), 'none');
});

test("regression: agents may edit only the config folder's roles and skills; the rest of it and .claude/ stay protected with no opt-out", () => {
  const C = BRAND.configDir;
  // Opted out (nothing listed) and the template's catch-all: the same answer either way.
  for (const protected_paths of [[], [`${C}/**`, '.claude/settings.json']]) {
    const g = GuardrailsConfig.parse({ version: 1, rules: [], protected_paths, examples: { must_block: [], must_ask: [], must_allow: [] } });
    const c = exampleContext(g, '/p', true);
    const tool = (t: string, path: string) => evaluate({ tool: t, input: { file_path: `/p/${path}` }, cwd: '/p' }, g, c).decision;
    const sh = (command: string) => evaluate({ tool: 'Bash', input: { command }, cwd: '/p' }, g, c).decision;
    const why = JSON.stringify(protected_paths);
    assert.equal(tool('Edit', `${C}/roles/worker.md`), 'none', why);
    assert.equal(tool('Write', `${C}/skills/x/SKILL.md`), 'none', why);
    assert.equal(sh(`echo more >> ${C}/roles/worker.md`), 'none', why);
    for (const path of [`${C}/config.yaml`, `${C}/guardrails.yaml`, `${C}/machine/x.sh`, `${C}/evals/roles/worker.md`, '.claude/settings.json']) {
      assert.equal(tool('Edit', path), 'deny', `${why} ${path}`);
      assert.equal(sh(`cp /tmp/x ${path}`), 'deny', `${why} cp ${path}`);
    }
    assert.equal(sh(`rm -rf ${C}`), 'deny', 'the whole folder holds protected files');
    assert.equal(sh(`mv /tmp/x ${C}`), 'deny');
  }
  // A project can still protect its role prompts too: its own entries only add.
  const tight = GuardrailsConfig.parse({ version: 1, rules: [], protected_paths: [`${C}/roles/**`], examples: { must_block: [], must_ask: [], must_allow: [] } });
  assert.equal(evaluate({ tool: 'Edit', input: { file_path: `/p/${C}/roles/worker.md` }, cwd: '/p' }, tight, exampleContext(tight, '/p', true)).decision, 'deny');
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

test('regression: an agent may not pick its own commit identity; reading one, or a plain commit, is fine', () => {
  // The live case: an agent committed as a person by setting these in front of git commit.
  for (const c of [
    'GIT_AUTHOR_NAME="Ada Example" GIT_AUTHOR_EMAIL=ada@example.com GIT_COMMITTER_NAME="Ada Example" GIT_COMMITTER_EMAIL=ada@example.com git commit -m fix',
    'env GIT_AUTHOR_EMAIL=ada@example.com git commit -m fix',
    'export GIT_COMMITTER_EMAIL=ada@example.com && git commit -m fix',
    'git -c user.name=Ada -c user.email=ada@example.com commit -m fix',
    'git -C . -c user.email=ada@example.com commit -m fix',
    'git commit --author="Ada <ada@example.com>" -m fix',
    'git config user.email ada@example.com',
    'git config --global user.name Ada',
    "bash -c 'GIT_AUTHOR_NAME=Ada git commit -m fix'",
  ]) assert.equal(bash(c), 'deny', c);
  for (const c of ['git commit -m "Shorten five descriptions"', 'git add -A && git commit -q -m fix', 'git log --author=ada -1', 'git config --get user.name', 'git config --list']) assert.equal(bash(c), 'none', c);
  assert.equal(bash('git -c user.email=ada@example.com commit -m fix', '/p', false), 'none', 'a human session commits as the human');
});

test('agents never write AGENTS.md, at the root or below it, by tool or shell; a person still may', () => {
  const write = (file_path: string, agent = true) => evaluate({ tool: 'Write', input: { file_path, content: 'x' }, cwd: '/p' }, cfg, ctx(agent));
  assert.deepEqual([write('/p/AGENTS.md').decision, write('/p/AGENTS.md').rule], ['deny', 'agents-md']);
  assert.equal(write('/p/packages/web/AGENTS.md').decision, 'deny');
  assert.equal(evaluate({ tool: 'Edit', input: { file_path: 'AGENTS.md', old_string: 'a', new_string: 'b' }, cwd: '/p' }, cfg, ctx()).rule, 'agents-md');
  assert.equal(bash("echo '- rule' >> AGENTS.md"), 'deny');
  assert.equal(bash('cat AGENTS.md'), 'none', 'reading it is fine');
  assert.equal(write('/p/AGENTS.md', false).decision, 'none', "a person's own session");
  assert.equal(write('/p/docs/agents.md').decision, 'none');
});
