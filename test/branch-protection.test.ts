// Branch protection as the harness recommends it (src/branch-protection.ts): not strict by default, strict only when
// config.yaml `protection.strict: true` opts a repo in; a config without the key loads; init's Protection step says it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { classicChecks, protectionAdvice, rulesetChecksRule } from '../src/branch-protection.js';
import { ConfigInvalid, loadConfig } from '../src/config/load.js';
import { initCommand, localInitFile, readInitState, type InitIo } from '../src/init.js';
import { exampleProject, repoRoot } from './helpers.js';

process.env[`${BRAND.envPrefix}_STATE_DIR`] ??= mkdtempSync(join(tmpdir(), 'bp-state-'));

const configFile = (dir: string) => join(dir, BRAND.configDir, 'config.yaml');
function withConfig(edit: (yaml: string) => string): string {
  const { dir } = exampleProject();
  writeFileSync(configFile(dir), edit(readFileSync(configFile(dir), 'utf8')));
  return dir;
}

test('a config without protection (every config before it) loads, and is not strict', () => {
  const { dir } = exampleProject();
  assert.doesNotMatch(readFileSync(configFile(dir), 'utf8'), /^protection:/m, 'the example has no protection key');
  assert.deepEqual(loadConfig(dir).project.protection, { strict: false });
});

test('protection.strict: true opts in; protection: {} is still not strict; a wrong value or unknown key is an error', () => {
  assert.equal(loadConfig(withConfig((y) => `${y}\nprotection: { strict: true }\n`)).project.protection.strict, true);
  assert.equal(loadConfig(withConfig((y) => `${y}\nprotection: {}\n`)).project.protection.strict, false);
  for (const bad of ['protection: { strict: "yes" }', 'protection: { strict: false, up_to_date: true }']) {
    assert.throws(() => loadConfig(withConfig((y) => `${y}\n${bad}\n`)), (e) => e instanceof ConfigInvalid && e.errors.some((x) => x.path.startsWith('protection')), bad);
  }
});

test('the recommended ruleset rule and classic protection follow protection.strict, with every required check', () => {
  const off = loadConfig(withConfig((y) => `${y}\nrequired_checks: ["test", "lint"]\n`)).project;
  assert.deepEqual(rulesetChecksRule(off), { type: 'required_status_checks', parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: 'test' }, { context: 'lint' }] } });
  assert.deepEqual(classicChecks(off), { strict: false, contexts: ['test', 'lint'] });
  assert.match(protectionAdvice(off), /require the 2 required_checks, not strict/);
  const on = { ...off, protection: { strict: true } };
  assert.equal(rulesetChecksRule(on).parameters.strict_required_status_checks_policy, true);
  assert.equal(classicChecks(on).strict, true);
  assert.match(protectionAdvice(on), /, strict \(PRs must be up to date first; config\.yaml protection\.strict: true\)/);
});

test('the template documents protection.strict, off', () => {
  assert.match(readFileSync(join(repoRoot, 'templates', 'project', 'config.yaml'), 'utf8'), /^# protection: \{ strict: false \}$/m);
});

/** init's Protection step alone, in a world where everything before it is done and GitHub doesn't protect main. */
async function protectionDetail(dir: string): Promise<string> {
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/example-org/example-shop.git'], { cwd: dir });
  const said: string[] = [];
  const io: InitIo = {
    which: (c) => `/stand-in/${c}`,
    run: (cmd, args, o = {}) => {
      if (cmd === 'git') {
        const r = spawnSync('git', args, { encoding: 'utf8', ...(o.cwd ? { cwd: o.cwd } : {}) });
        return { status: r.status, stdout: r.stdout, stderr: r.stderr };
      }
      const a = args.join(' ');
      if (cmd === 'claude' && args[0] === '-p') return { status: 0, stdout: '{"type":"result","subtype":"success","is_error":false,"result":"ok"}', stderr: '' }; // the login's proof: a minimal real call, answered
      if (cmd === 'claude' && a === 'auth status') return { status: 0, stdout: '{"loggedIn": true, "authMethod": "claude.ai"}', stderr: '' };
      if (cmd === 'gh' && a === 'auth status') return { status: 0, stdout: '', stderr: '' };
      if (cmd === 'gh' && /--jq \.permissions\.push$/.test(a)) return { status: 0, stdout: 'true\n', stderr: '' };
      if (cmd === 'gh' && /\/protection --silent$/.test(a)) return { status: 1, stdout: '', stderr: 'gh: Branch not protected (HTTP 404)' };
      return { status: 1, stdout: '', stderr: `no stand-in for ${cmd} ${a}` };
    },
    interactive: async () => 0,
    ask: async () => null,
    say: (l) => said.push(l),
    download: async () => {},
    plan: () => {
      throw new Error('nothing to install');
    },
    addProject: async () => ({ code: 1, steps: {}, last: 'none' }),
  };
  await initCommand({ target: dir, mode: 'local', instance: undefined, yes: false, reset: false, cwd: dir, prefix: mkdtempSync(join(tmpdir(), 'bp-prefix-')), interactive: false }, io);
  const s = readInitState(localInitFile(dir));
  return s?.steps.protection?.detail ?? `no protection step: ${said.join('\n')}`;
}

test("init's Protection step recommends not strict by default, and strict when the repo opts in", async () => {
  assert.match(await protectionDetail(exampleProject().dir), /main isn't protected on GitHub yet: Protect requires your checks[^;]*; recommended: require your CI checks \(config\.yaml required_checks is empty\), not strict/);
  assert.match(await protectionDetail(withConfig((y) => `${y}\nprotection: { strict: true }\n`)), /recommended: require your CI checks \(config\.yaml required_checks is empty\), strict \(PRs must be up to date first/);
});
