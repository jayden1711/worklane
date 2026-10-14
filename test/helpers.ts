import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { agentSettingsPath } from '../src/agent-settings.js';
import { agentSettings } from '../src/install.js';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const engineCli = join(repoRoot, 'dist', 'src', 'cli.js');

/** A throwaway git repo copied from examples/basic, with its own state dir. */
export function exampleProject(): { dir: string; stateDir: string } {
  const base = mkdtempSync(join(tmpdir(), 'proj-'));
  const dir = join(base, 'example');
  cpSync(join(repoRoot, 'examples', 'basic'), dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'ada@example.com');
  git('config', 'user.name', 'Ada');
  git('config', 'commit.gpgsign', 'false');
  // No background maintenance or auto-gc: a detached `git maintenance` run adds and removes .git/objects/maintenance.lock
  // while a test walks the tree (chmod -R failed on main: the lock vanished mid-walk).
  git('config', 'maintenance.auto', 'false');
  git('config', 'gc.auto', '0');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return { dir, stateDir: join(base, 'state') };
}

/**
 * Point a test instance's run_as at the current user, and give its agents their guardrail settings, so a
 * coordinator started in a test passes the agent-user and agent-hooks checks.
 */
export function agentIsSelf(instanceHome: string): void {
  const f = join(instanceHome, 'instance.yaml');
  writeFileSync(f, readFileSync(f, 'utf8').replace(/^ {2}agent_user: .*$/m, `  agent_user: ${userInfo().username}`).replace(/^ {2}agent_home: .*$/m, `  agent_home: ${JSON.stringify(homedir())}`));
  writeFileSync(agentSettingsPath(instanceHome), JSON.stringify(agentSettings(engineCli, [], [], [])), { mode: 0o600 });
}

/**
 * For stand-in claudes: a JS expression that reads the first line of stdin, as claude reads its first
 * stream-json message (stdin stays open for the run, so reading to the end would wait for ever).
 */
/**
 * Roles on the example project's instance, as its repo would give them: example-owner is an admin (owner),
 * example-collaborator has write (writer), anyone else read (viewer). For a dashboard started with
 * `roleOf: exampleRoles`, a request that names a person (`asPerson`) gets that person's role.
 */
export const exampleRole = (login: string): 'owner' | 'writer' | 'viewer' => {
  const l = login.toLowerCase();
  return l === 'example-owner' ? 'owner' : l === 'example-collaborator' ? 'writer' : 'viewer';
};
export const exampleRoles = async (login: string) => exampleRole(login);
/** The header the hub names a signed-in person with (src/dashboard-auth.ts LOGIN_HEADER). */
export const asPerson = (login: string): Record<string, string> => ({ 'x-dashboard-login': login });
/**
 * A person as the hub names them on a machine change, from an allowed console device (DEVICE_HEADER), which
 * machine changes need (src/machine-owners.ts).
 */
export const asDevicePerson = (login: string): Record<string, string> => ({ ...asPerson(login), 'x-dashboard-console-device': '1' });
/** A machine owners file naming these logins (src/machine-owners.ts), this user's, 0644. */
export function machineOwnersFile(...logins: string[]): string {
  const f = join(mkdtempSync(join(tmpdir(), 'machine-owners-')), 'machine-owners.json');
  writeFileSync(f, `${JSON.stringify({ owners: logins })}\n`, { mode: 0o644 });
  return f;
}
/** A person asking for a machine change through the dashboard, from an allowed device. */
export const ownerRequester = (login: string) => ({ login, breakGlass: false, deviceOk: true });

export const STDIN_LINE = `(() => { const fs = require('node:fs'); const b = Buffer.alloc(1); const out = []; for (;;) { let n = 0; try { n = fs.readSync(0, b, 0, 1, null); } catch (e) { if (e.code === 'EAGAIN') continue; throw e; } if (!n || b[0] === 10) break; out.push(b[0]); } return Buffer.from(out).toString('utf8'); })()`;

/** What one instance's items are marked with, so a test can tell whose items a response or a page carries. */
export interface InstanceMarks {
  /** Its project name: its agent slots and land gate are held as `<cli> <project> ...`. */
  project: string;
  /** Its coordinator's user@host: its test slots are held as `<actor> test run <id>`. */
  actor: string;
  /** The first of its three issues (in flight, waiting on a decision, blocked); its PR; its test run's id. */
  issue: number;
  pr: number;
  run: string;
  title: string;
}

/**
 * Seed an instance's log with an item on every page: a task in flight with an agent running and a PR (Board,
 * Issues, PRs, Agents, Activity), a decision waiting (Board's Waiting on you, Decisions, Inbox, Waiting), a blocked
 * task (Waiting, Overview), and a queued test run (the test-runs strip).
 */
export function seedInstanceItems(log: { append(type: string, data: unknown, actor: string): unknown }, m: InstanceMarks): void {
  const sha = (c: string) => c.repeat(40);
  const seen = (issue: number, title: string) => log.append('issue.seen', { issue, title, labels: ['ready'], author: 'example-owner', owner: null, actionable: true, why: '' }, m.actor);
  seen(m.issue, `${m.title} in flight`);
  log.append('issue.claimed', { issue: m.issue, instance: m.actor, lease: sha('a'), base: sha('b'), owner: 'example-owner' }, m.actor);
  log.append('run.started', { issue: m.issue, role: 'worker', model: 'sonnet', worktree: `/w/${m.project}`, pid: process.pid, pgid: null, attempt: 1 }, m.actor);
  log.append('pr.opened', { issue: m.issue, number: m.pr, url: `https://example.test/${m.project}/pull/${m.pr}`, head: sha('c'), draft: true }, m.actor);
  seen(m.issue + 1, `${m.title} waiting`);
  log.append('decision.asked', { id: `${m.run}-ask`, kind: 'question', issue: m.issue + 1, owner: 'example-owner', question: `${m.title}: which way?`, options: ['this', 'that'], recommendation: 'this', receipts: [] }, m.actor);
  seen(m.issue + 2, `${m.title} blocked`);
  log.append('issue.blocked', { issue: m.issue + 2, owner: 'example-owner', why: `${m.title} needs a key` }, m.actor);
  log.append('testrun.queued', { id: m.run, sha: sha('d'), kind: 'fast', prs: [m.pr], shard: null }, m.actor);
}

/** Every trace of one instance's items a response or page could carry: its issue numbers, PR, run, project, actor and titles. */
// A number marks an item only as a whole number: b's PR 9270 must not match a byte count like 15381192704.
export const marksOf = (m: InstanceMarks): RegExp =>
  new RegExp([...[m.issue, m.issue + 1, m.issue + 2, m.pr].map((n) => `(?<![0-9])${n}(?![0-9])`), ...[m.run, m.project, m.actor, m.title].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))].join('|'));

/**
 * A child engine process's GitHub, when a test runs the CLI as its own process against a fake on this machine: the
 * engine's GitHub hosts are constants (src/github-hosts.ts), so the child loads the loopback stand-in
 * (scripts/ci/loopback-github.mjs), which is told a port on 127.0.0.1 and nothing else. `api` is the fake's URL.
 */
export function loopbackGitHub(api: string): Record<string, string> {
  const u = new URL(api);
  if (u.hostname !== '127.0.0.1') throw new Error(`a fake GitHub on 127.0.0.1, not ${u.hostname}`);
  return { NODE_OPTIONS: `--import=${pathToFileURL(join(repoRoot, 'scripts', 'ci', 'loopback-github.mjs')).href}`, CI_LOOPBACK_GITHUB_PORT: u.port };
}
