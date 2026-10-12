// `add <owner/repo>`: onboard a project, start to finish. Every step is idempotent and recorded as an event
// (onboard.step) in the onboarding folder's own log, so a re-run skips what's done and continues where it
// stopped. Everything only the owner can do is an ask (console/asks.ts): a question, a link to approve, a
// secret to paste, or a root step, which is only ever one machine-helper setup command (console/setup-steps.ts).
//
// The App's key is in the owner's hands (staged owner-only here) only until the root step that installs it for
// the coordinator; the labels and the setup PR are made with it before that, and the staged copy is then deleted.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LABELS } from '../backlog/types.js';
import { BRAND } from '../brand.js';
import { asks, recordAnswer, type Ask, type AskInput, type Asks } from '../console/asks.js';
import { DIGEST_LABEL } from '../coordinator/digest.js';
import { EventLog } from '../events/log.js';
import type { EventPayload } from '../events/types.js';
import { HUB_PORT } from '../dashboard-hub.js';
import { MACHINE_HELPER } from '../machine.js';
import { checkedPush, DEFAULT_PUSH_LIMITS } from '../push-check.js';
import { ownerOnlyDir, stateDir, userExists, writeOwnerOnly } from '../os/index.js';
import { RESEARCH_LABELS } from '../research.js';
import { dropSecret, outputPath, readSecret, stagedSecrets, stageSecret } from './answer.js';
import { developerPortal, inviteUrl, type DiscordCheck } from './discord.js';
import { onboardDoctor, type FixedCheck } from './doctor.js';
import { proposedRuleset, type OnboardGitHub, type OwnerGitHub } from './github.js';
import { installUrl, startManifestServer, type ManifestServer } from './manifest.js';
import { detectStack, writeProjectConfig } from './stack.js';

export const SETUP_BRANCH = `${BRAND.cli}/setup`;
/** The engine's own checkout (dist/src/onboard -> the repo root): its setup scripts and app-permissions rules. */
export const ENGINE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The labels the engine uses: the backlog's, the research ones and the digest's. */
export const ENGINE_LABELS: { name: string; color: string; description: string }[] = [
  ...LABELS,
  ...RESEARCH_LABELS.filter((n) => !LABELS.some((l) => l.name === n)).map((name) => ({ name, color: 'c5def5', description: 'A research run: findings with sources, no code change' })),
  { name: DIGEST_LABEL, color: 'ededed', description: `${BRAND.name} posts the daily "waiting on you" digest here` },
];

/** What onboarding can see of the machine without root (a fake in tests). */
export interface MachineProbe {
  exists(path: string): boolean;
  userExists(user: string): boolean;
  /** Whether this user may run the helper's setup commands without a password. */
  helperReady(): boolean;
  /** The instances that have a coordinator service on this machine (from the unit files, which anyone can read). */
  instances(): string[];
}

export function realProbe(): MachineProbe {
  return {
    exists: existsSync,
    userExists,
    helperReady: () => {
      try {
        execFileSync('sudo', ['-n', '-l', MACHINE_HELPER, 'add-instance', 'x'], { stdio: 'ignore', timeout: 10_000 });
        return true;
      } catch {
        return false;
      }
    },
    instances: () => {
      try {
        const re = new RegExp(`^${BRAND.cli}-([a-z][a-z0-9-]{0,20})\\.service$`);
        return execFileSync('ls', ['/etc/systemd/system'], { encoding: 'utf8' })
          .split('\n')
          .map((f) => re.exec(f)?.[1])
          .filter((n): n is string => !!n && !n.startsWith('dashboard-'))
          .sort();
      } catch {
        return [];
      }
    },
  };
}

/** The engine commit to install: the machine's current engine, else this checkout's HEAD. */
export function realEngineRef(): string | null {
  try {
    const sha = basename(realpathSync(`/opt/${BRAND.cli}/current`));
    if (/^[0-9a-f]{40}$/.test(sha)) return sha;
  } catch {
    // no machine engine yet
  }
  try {
    const sha = execFileSync('git', ['-C', ENGINE_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

type Problems = { errors: string[]; warnings: string[] };
export interface PermissionRules {
  permissionProblems(p: Record<string, string>): Problems;
  scopeProblem(reached: string[], repo: string, shared?: boolean): string | null;
}
/** The App rules the setup script checks, from that same script (scripts/setup/app-permissions.mjs). */
export async function appPermissionRules(root = ENGINE_ROOT): Promise<PermissionRules> {
  return (await import(pathToFileURL(join(root, 'scripts', 'setup', 'app-permissions.mjs')).href)) as PermissionRules;
}

export interface OnboardDeps {
  github: OnboardGitHub;
  owner: OwnerGitHub;
  discord: DiscordCheck;
  /** A problem with an Anthropic API key, or null when it works (a read-only call). */
  anthropic: (key: string) => Promise<string | null>;
  probe: MachineProbe;
  engineRef: () => string | null;
  rules: () => Promise<PermissionRules>;
  manifest: typeof startManifestServer;
  /** git, with its environment; a fake remote in tests is a local bare repo. */
  git: (args: string[], cwd: string, env: NodeJS.ProcessEnv) => string;
}

export function realDeps(o: Pick<OnboardDeps, 'github' | 'owner' | 'discord'>): OnboardDeps {
  return {
    ...o,
    anthropic: async (key) => {
      const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
      return r.ok ? null : r.status === 401 ? 'Anthropic refused the key (401)' : `Anthropic ${r.status} checking the key`;
    },
    probe: realProbe(),
    engineRef: realEngineRef,
    rules: () => appPermissionRules(),
    manifest: startManifestServer,
    git: (args, cwd, env) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000 }),
  };
}

export interface OnboardOptions {
  repo: string;
  /** The instance name (default: from the repo's name). */
  name?: string;
  /** Who answers as the owner (their GitHub login, else this OS user). */
  by?: string;
  /** Where onboarding keeps its log, staged secrets and working clone (default: under the state dir). */
  dir?: string;
  /** How often to look for an answer. */
  pollMs?: number;
  signal?: AbortSignal;
  /** Called with each recorded step, for progress output. */
  onStep?: (s: EventPayload<'onboard.step'>) => void;
}

export const onboardingRoot = () => join(stateDir(), 'onboarding');
export const onboardingDir = (repo: string, root = onboardingRoot()) => join(root, repo.toLowerCase().replace('/', '--'));
export const onboardingLog = (dir: string) => join(dir, 'log', 'events.db');

/** An instance name from a repo's name: lowercase letters, digits and dashes, starting with a letter, 21 at most. */
export function instanceNameFor(repo: string): string {
  const n = (repo.split('/')[1] ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 21)
    .replace(/-+$/, '')
    .replace(/-(agent|eval|work)$/, '');
  return n && n !== 'dash' ? n : 'project';
}

export const STEP_ORDER = ['app', 'install', 'labels', 'budget', 'config', 'ruleset', 'helper', 'machine', 'instance', 'engine', 'app-key', 'budget-cap', 'merge', 'checkout', 'service', 'dashboards', 'claude', 'discord', 'tailscale', 'doctor'] as const;
export type StepId = (typeof STEP_ORDER)[number];
export const STEP_TITLES: Record<StepId, string> = {
  app: 'GitHub App',
  install: 'App installed on the repo only',
  labels: 'Labels',
  budget: 'Daily budget',
  config: `${BRAND.configDir}/ from the detected stack, as a PR`,
  ruleset: 'Main-branch ruleset',
  helper: "The machine helper's setup commands",
  machine: 'Machine roots and agent slots',
  instance: 'Coordinator and agent users',
  engine: 'Engine and instance home',
  'app-key': "The App's key, for the coordinator only",
  'budget-cap': "The instance's budget cap",
  merge: 'The setup PR, merged by you',
  checkout: 'Checkout and agent hooks',
  service: 'Coordinator service',
  dashboards: 'Dashboards',
  claude: 'Claude sign-in',
  discord: 'Discord bot (optional)',
  tailscale: 'Tailscale (optional)',
  doctor: 'Doctor',
};

type Data = Record<string, string | number | boolean | null>;
/** An ask without its instance (the run's own). */
type AskSpec = AskInput extends unknown ? (AskInput extends infer T ? (T extends AskInput ? Omit<T, 'instance'> : never) : never) : never;
type StepResult = { status: 'done' | 'skipped'; detail: string; data?: Data };

export class OnboardError extends Error {}

/** One onboarding run over its log. */
export class Onboarding {
  readonly log: EventLog;
  readonly asks: Asks;
  readonly dir: string;
  readonly repo: string;
  readonly name: string;
  readonly by: string;
  private readonly pollMs: number;
  report: FixedCheck[] = [];

  constructor(
    o: OnboardOptions,
    readonly deps: OnboardDeps,
  ) {
    if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(o.repo) || o.repo.includes('..')) throw new OnboardError(`${o.repo} is not owner/repo`);
    this.repo = o.repo;
    this.name = o.name ?? instanceNameFor(o.repo);
    if (!/^[a-z][a-z0-9-]{0,20}$/.test(this.name) || this.name === 'dash' || /-(agent|eval|work)$/.test(this.name)) throw new OnboardError(`instance name ${this.name}: lowercase letters, digits and dashes, 21 at most, not ending in -agent, -eval or -work`);
    this.dir = o.dir ?? onboardingDir(o.repo);
    ownerOnlyDir(this.dir);
    // In a folder of its own: the log makes its folder group-readable, and the onboarding folder stays owner-only.
    this.log = new EventLog(onboardingLog(this.dir));
    this.asks = asks(this.log);
    this.by = o.by ?? userInfo().username;
    this.pollMs = o.pollMs ?? 500;
    this.signal = o.signal;
    this.onStep = o.onStep;
  }
  private signal: AbortSignal | undefined;
  private onStep: OnboardOptions['onStep'];

  close() {
    this.log.close();
  }

  // ---- progress ----

  steps(): EventPayload<'onboard.step'>[] {
    return this.log.read(0, ['onboard.step']).map((e) => e.payload as EventPayload<'onboard.step'>);
  }
  /** A step's latest record when it's done or skipped. */
  done(step: StepId): EventPayload<'onboard.step'> | null {
    const last = this.steps().filter((s) => s.step === step).at(-1);
    return last && last.status !== 'failed' ? last : null;
  }
  data(step: StepId): Data {
    return this.done(step)?.data ?? {};
  }
  private record(step: StepId, status: 'done' | 'skipped' | 'failed', detail: string, data: Data = {}) {
    const p = { repo: this.repo, instance: this.name, step, status, detail: detail.slice(0, 4000), data };
    this.log.append('onboard.step', p, 'onboarding', 'coordinator');
    this.onStep?.(p);
  }

  // ---- asks ----

  private async sleep(ms: number) {
    await new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      this.signal?.addEventListener('abort', () => (clearTimeout(t), r()), { once: true });
    });
    if (this.signal?.aborted) throw new OnboardError('stopped');
  }

  async waitFor(id: string, also?: Promise<unknown>): Promise<Ask> {
    let extra = false;
    also?.then(
      () => (extra = true),
      () => (extra = true),
    );
    for (;;) {
      const a = this.asks.get(id);
      if (!a) throw new OnboardError(`ask ${id} vanished`);
      if (a.status !== 'open' || extra) return a;
      await this.sleep(this.pollMs);
    }
  }

  /**
   * Ask once per key: a re-run waits on the same open ask (or takes its unused answer) instead of asking again.
   * `fresh`: withdraw an open one first (its link is dead after a restart, like the manifest page's).
   */
  async ask(key: string, input: AskSpec, o: { fresh?: boolean; also?: Promise<unknown> } = {}): Promise<Ask> {
    const prior = this.log
      .read(0, ['onboard.ask'])
      .map((e) => e.payload as EventPayload<'onboard.ask'>)
      .filter((p) => p.key === key);
    const last = prior.at(-1);
    let ask: Ask | null = last && !last.used ? this.asks.get(last.id) : null;
    if (ask && ask.status === 'open' && o.fresh) {
      this.asks.cancel(ask.id, 'onboarding', 'asked again: the earlier link no longer works');
      ask = null;
    }
    if (ask && ask.status === 'cancelled') ask = null;
    if (!ask) {
      ask = this.asks.create({ ...input, instance: this.name } as AskInput, 'onboarding');
      this.log.append('onboard.ask', { repo: this.repo, key, id: ask.id, used: false }, 'onboarding', 'coordinator');
    }
    const answered = ask.status === 'open' ? await this.waitFor(ask.id, o.also) : ask;
    if (answered.status !== 'open') this.log.append('onboard.ask', { repo: this.repo, key, id: ask.id, used: true }, 'onboarding', 'coordinator');
    return answered;
  }

  async question(key: string, title: string, detail: string, options: string[]): Promise<string> {
    const a = await this.ask(key, { kind: 'question', title, detail, options });
    if (a.status === 'cancelled') throw new OnboardError(`${title}: withdrawn`);
    return a.answer!.answer;
  }

  async approve(key: string, title: string, detail: string, url: string, o: { fresh?: boolean; also?: Promise<unknown> } = {}): Promise<Ask> {
    const a = await this.ask(key, { kind: 'approve_link', title, detail, url }, o);
    if (a.status === 'answered' && a.answer!.answer === 'declined') throw new OnboardError(`${title}: declined`);
    return a;
  }

  /** A secret, pasted: staged owner-only by whoever answered (answer.ts). Asks only while none is staged. */
  async secret(key: string, credential: string, title: string, detail: string, where: string, o: { fresh?: boolean; also?: Promise<unknown> } = {}): Promise<string | null> {
    const staged = readSecret(this.dir, credential);
    if (staged && !o.fresh) return staged;
    if (o.fresh) dropSecret(this.dir, credential);
    await this.ask(key, { kind: 'paste_secret', title, detail, credential, where }, o);
    return readSecret(this.dir, credential);
  }

  /** A root step: one helper setup command. It returns what the command printed; a failure stops the run. */
  async root(key: string, title: string, detail: string, command: string, args: string[], o: { mayFail?: boolean } = {}): Promise<{ ok: boolean; output: string; detail: string }> {
    const a = await this.ask(key, { kind: 'root_step', title, detail, command, args });
    if (a.kind === 'root_step' && !a.allowed) throw new OnboardError(`${title}: ${a.refusal}`);
    if (a.status === 'cancelled') throw new OnboardError(`${title}: withdrawn`);
    const ans = a.answer!;
    if (ans.answer === 'declined') throw new OnboardError(`${title}: declined; run \`${BRAND.cli} add ${this.repo}\` again to continue`);
    let output = '';
    try {
      output = readFileSync(outputPath(this.dir, a.id), 'utf8');
    } catch {
      // nothing printed
    }
    if (ans.answer !== 'ran' && !o.mayFail) throw new OnboardError(`${title} failed: ${ans.detail}`);
    return { ok: ans.answer === 'ran', output, detail: ans.detail };
  }

  // ---- the App's key, while it's still here ----

  private pem(): string {
    const k = readSecret(this.dir, 'github-app-key');
    if (!k) throw new OnboardError(`no App key staged any more (it went to the coordinator); later GitHub steps run before it, so re-run \`${BRAND.cli} add ${this.repo}\` from the App step`);
    return k;
  }
  async token(): Promise<string> {
    const app = this.data('app');
    const inst = this.data('install');
    return (await this.deps.github.mintToken(Number(app.app_id), this.pem(), Number(inst.installation_id), app.mode === 'shared' ? this.repo : undefined)).token;
  }

  private gitEnv(token: string | null): NodeJS.ProcessEnv {
    const hooks = mkdtempSync(join(this.dir, 'no-hooks-'));
    const cfg: [string, string][] = [
      ['core.hooksPath', hooks],
      ['credential.helper', ''],
      ...(token ? ([['credential.helper', '!f() { echo username=x-access-token; echo "password=$ONBOARD_GIT_TOKEN"; }; f']] as [string, string][]) : []),
      ['user.name', `${BRAND.cli} setup`],
      ['user.email', 'noreply@localhost'],
      ['commit.gpgsign', 'false'],
    ];
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: String(cfg.length), ...(token ? { ONBOARD_GIT_TOKEN: token } : {}) };
    cfg.forEach(([k, v], i) => ((env[`GIT_CONFIG_KEY_${i}`] = k), (env[`GIT_CONFIG_VALUE_${i}`] = v)));
    return env;
  }

  /**
   * Push the setup branch, and only it: the ref is fixed here, so no step can push the default branch. Through
   * checkedPush, like every engine push: the push limits apply, and it only ever fast-forwards.
   */
  private pushSetupBranch(clone: string, env: NodeJS.ProcessEnv, defaultBranch: string) {
    if (defaultBranch === SETUP_BRANCH) throw new OnboardError(`the default branch is ${SETUP_BRANCH}; refusing to push it`);
    const head = this.deps.git(['rev-parse', 'HEAD'], clone, env).trim();
    const base = this.deps.git(['rev-parse', `origin/${defaultBranch}`], clone, env).trim();
    const r = checkedPush({ cwd: clone, remote: 'origin', base, head, ref: `refs/heads/${SETUP_BRANCH}`, limits: DEFAULT_PUSH_LIMITS, env });
    if (!r.ok) throw new OnboardError(`pushing ${SETUP_BRANCH}: ${'refused' in r ? r.refused.join('; ') : r.error}`);
  }

  // ---- the steps ----

  private async stepApp(): Promise<StepResult> {
    const owner = this.repo.split('/')[0]!;
    const registryFile = join(dirnameOf(this.dir), 'apps.json');
    let registry: Record<string, { app_id: number; slug: string }> = {};
    try {
      registry = JSON.parse(readFileSync(registryFile, 'utf8')) as typeof registry;
    } catch {
      // no shared App yet
    }
    const sharedApp = registry[owner.toLowerCase()];
    const mode = await this.question(
      'app-mode',
      `One GitHub App for all of ${owner}'s projects, or one for ${this.repo}?`,
      `per-project: a new App installed on ${this.repo} only; its key reaches nothing else. shared: one App for ${owner}'s projects${sharedApp ? ` (${sharedApp.slug}, made earlier)` : ', made now'}; each project gets its own key of it, and the coordinator's tokens are limited to its repo.`,
      ['per-project', 'shared'],
    );
    if (mode === 'shared' && sharedApp) {
      const pem = await this.secret(
        'app-key-shared',
        'github-app-key',
        `A new private key for ${sharedApp.slug}`,
        `Open the App's settings (https://github.com/settings/apps/${sharedApp.slug}, or the organization's), Private keys, Generate a private key, and paste the downloaded .pem's contents here. One key per project: each can be revoked alone. Delete the download afterwards.`,
        "the coordinator's App key (installed by the next root steps, then deleted here)",
      );
      if (!pem) throw new OnboardError('no key pasted');
      const slug = await this.deps.github.appSlug(sharedApp.app_id, pem);
      if (slug !== sharedApp.slug) throw new OnboardError(`that key signs for ${slug}, not ${sharedApp.slug}`);
      return { status: 'done', detail: `shared App ${slug} (${sharedApp.app_id}), with a key of this project's own`, data: { app_id: sharedApp.app_id, slug, mode } };
    }
    const ownerType = await this.deps.github.ownerType(owner);
    let srv: ManifestServer | null = null;
    try {
      srv = await this.deps.manifest({ repo: this.repo, shared: mode === 'shared', owner, ownerType });
      const fromBrowser = srv.code;
      const link = await this.approve(
        'app-create',
        `Create the GitHub App for ${mode === 'shared' ? owner : this.repo}`,
        `Open this page on this machine (or through an ssh tunnel to it) and continue to GitHub. GitHub shows the App before creating it: no webhook, and only metadata read, contents write, issues write, pull requests write, checks read, actions read. Then it sends you back here and setup continues.`,
        srv.url,
        { fresh: true, also: fromBrowser },
      );
      let code = await Promise.race([fromBrowser, new Promise<null>((r) => setTimeout(() => r(null), 0))]);
      if (code && link.status === 'open') recordAnswer(this.log, link.id, { by: this.by, role: 'owner', answer: 'approved', detail: 'GitHub sent the browser back with the code' });
      if (!code) {
        // Approved, but GitHub's redirect to 127.0.0.1 didn't reach this machine (a browser elsewhere): the code is in its address bar.
        await this.secret('app-code', 'github-manifest-code', 'The code from the address bar', `GitHub sent your browser to ${srv.redirectUrl}?code=...; if that page didn't load, copy the code= value from the address bar and paste it here (it works once, within an hour).`, 'nowhere: exchanged once for the App', { fresh: true, also: fromBrowser });
        code = (await Promise.race([fromBrowser, new Promise<null>((r) => setTimeout(() => r(null), 0))])) ?? readSecret(this.dir, 'github-manifest-code');
        dropSecret(this.dir, 'github-manifest-code');
      }
      if (!code) throw new OnboardError('no code from GitHub');
      const app = await this.deps.github.convertManifest(code);
      stageSecret(this.dir, 'github-app-key', app.pem);
      if (mode === 'shared') {
        registry[owner.toLowerCase()] = { app_id: app.id, slug: app.slug };
        writeOwnerOnly(registryFile, JSON.stringify(registry, null, 2) + '\n');
      }
      return { status: 'done', detail: `created App ${app.slug} (${app.id})${mode === 'shared' ? `, shared by ${owner}'s projects` : ''}`, data: { app_id: app.id, slug: app.slug, mode } };
    } finally {
      await srv?.close();
    }
  }

  private async stepInstall(): Promise<StepResult> {
    const app = this.data('app');
    const shared = app.mode === 'shared';
    const appId = Number(app.app_id);
    const slug = String(app.slug);
    const rules = await this.deps.rules();
    let inst: number | null = null;
    for (let i = 0; i < 5 && inst === null; i++) {
      inst = await this.deps.github.installationFor(appId, this.pem(), this.repo);
      if (inst !== null) break;
      const ids = await this.deps.owner.repoIds(this.repo);
      await this.approve(
        `app-install-${i}`,
        `Install ${slug} on ${this.repo}, and only it`,
        shared ? `Add ${this.repo} to the App's installation (Only select repositories). The coordinator's tokens are limited to this repo either way.` : `Choose "Only select repositories" and pick ${this.repo}. Setup checks that the installation reaches nothing else.`,
        installUrl(slug, ids ?? undefined),
      );
    }
    if (inst === null) throw new OnboardError(`${slug} is still not installed on ${this.repo}`);
    const t = await this.deps.github.mintToken(appId, this.pem(), inst, shared ? this.repo : undefined);
    const scope = rules.scopeProblem(await this.deps.github.reposOf(t.token), this.repo, shared);
    if (scope) throw new OnboardError(`${scope}: edit the installation's repository access on GitHub, then re-run`);
    const p = rules.permissionProblems(t.permissions);
    if (p.errors.length) throw new OnboardError(`the App's permissions: ${p.errors.join('; ')}`);
    return { status: 'done', detail: `installation ${inst} reaches only ${this.repo}${p.warnings.length ? `; ${p.warnings.join('; ')}` : ''}`, data: { installation_id: inst } };
  }

  private async stepLabels(): Promise<StepResult> {
    const created = await this.deps.github.ensureLabels(await this.token(), this.repo, ENGINE_LABELS);
    return { status: 'done', detail: created.length ? `created ${created.join(', ')}` : 'all labels exist', data: { created: created.length } };
  }

  private async stepBudget(): Promise<StepResult> {
    const usd = await this.question('budget', 'Daily budget for agent runs (USD, estimated spend)', `The coordinator stops starting runs for the day once agents' estimated spend reaches it. It goes in the instance's policy (the cap) and in the repo's agents.yaml; you can lower it later from the dashboard.`, ['5', '10', '20', '40', '80']);
    return { status: 'done', detail: `$${usd}/day`, data: { usd: Number(usd) } };
  }

  private async stepConfig(): Promise<StepResult> {
    const token = await this.token();
    const env = this.gitEnv(token);
    const clone = join(this.dir, 'checkout');
    const g = (...a: string[]) => this.deps.git(a, clone, env);
    if (!existsSync(join(clone, '.git'))) {
      mkdirSync(clone, { recursive: true });
      this.deps.git(['clone', '-q', this.deps.github.gitUrl(this.repo), clone], this.dir, env);
    } else g('fetch', '-q', 'origin');
    const def = await this.deps.github.defaultBranch(token, this.repo);
    const hasSetup = g('ls-remote', '--heads', 'origin', SETUP_BRANCH).trim() !== '';
    if (hasSetup) {
      g('fetch', '-q', 'origin', `${SETUP_BRANCH}:refs/remotes/origin/${SETUP_BRANCH}`);
      g('checkout', '-q', '-B', SETUP_BRANCH, `origin/${SETUP_BRANCH}`);
    } else {
      let onDefault = true;
      try {
        g('cat-file', '-e', `origin/${def}:${BRAND.configDir}/config.yaml`);
      } catch {
        onDefault = false;
      }
      g('checkout', '-q', '-B', onDefault ? def : SETUP_BRANCH, `origin/${def}`);
      if (onDefault) {
        const stack = detectStack(clone);
        return { status: 'skipped', detail: `${def} already has ${BRAND.configDir}/; nothing to propose`, data: { pr: null, default_branch: def, checks: JSON.stringify(stack.checks), merged: true } };
      }
    }
    const stack = detectStack(clone);
    let notes: string[] = [];
    if (!existsSync(join(clone, BRAND.configDir))) {
      notes = writeProjectConfig(clone, stack, { name: this.name, repo: this.repo, defaultBranch: def, owner: this.by, dailyBudgetUsd: Number(this.data('budget').usd) });
      g('add', '--', BRAND.configDir);
      g('commit', '-q', '-m', `Add ${BRAND.name} config (to review before the first task)`);
    }
    this.pushSetupBranch(clone, env, def);
    const body = [
      `${BRAND.name}'s config for this repo, from what setup found in it (nothing was run):`,
      '',
      `- **Stack:** ${stack.ecosystem}${stack.packageManager ? `, ${stack.packageManager}` : ''}${stack.lockfile ? ` (${stack.lockfile})` : ''}${stack.testRunner ? `; tests with ${stack.testRunner}` : ''}`,
      `- **Tests:** \`${stack.commands.test ?? 'not found: set tests.yaml by hand'}\`${stack.commands.install ? `; worktrees set up with \`${stack.commands.install}\`` : ''}`,
      `- **Required checks:** ${stack.checks.length ? stack.checks.map((c) => `\`${c}\``).join(', ') : 'none found'}`,
      `- **Budget:** $${this.data('budget').usd}/day`,
      ...notes.map((n) => `- Note: ${n}`),
      '',
      `Review it (owners, guardrails, tests), adjust it here, and merge it yourself; ${BRAND.name} never pushes the default branch.`,
    ].join('\n');
    const pr = (await this.deps.github.findPr(token, this.repo, SETUP_BRANCH)) ?? (await this.deps.github.openPr(token, this.repo, { head: SETUP_BRANCH, base: def, title: `Add ${BRAND.name} config`, body }));
    return { status: 'done', detail: `PR ${pr.url}`, data: { pr: pr.url, default_branch: def, checks: JSON.stringify(stack.checks), merged: false } };
  }

  private checks(): string[] {
    try {
      return JSON.parse(String(this.data('config').checks ?? '[]')) as string[];
    } catch {
      return [];
    }
  }

  private async stepRuleset(): Promise<StepResult> {
    const checks = this.checks();
    if (!checks.length) return { status: 'skipped', detail: 'no CI checks found on pull requests: no ruleset to propose' };
    const def = String(this.data('config').default_branch);
    const rs = proposedRuleset(checks, `${BRAND.name}: ${def}`);
    const choice = await this.question(
      'ruleset',
      `Protect ${def}: require ${checks.length} check(s), up to date before merging`,
      `It changes ${this.repo}'s branch protection, so it is yours to approve; it's applied with your own gh login (the App can't: it has no Administration). Required on ${def}: ${checks.join(', ')}. Pull requests must be up to date with ${def} before they merge; no force-pushes or deletion of ${def}.\n\n${JSON.stringify(rs, null, 1)}`.slice(0, 3900),
      ['apply', 'skip'],
    );
    if (choice === 'skip') return { status: 'skipped', detail: 'you chose not to add the ruleset' };
    const r = await this.deps.owner.applyRuleset(this.repo, rs);
    return { status: 'done', detail: `${r.created ? 'created' : 'updated'} ruleset ${r.id} on ${def}`, data: { ruleset_id: r.id } };
  }

  private async stepHelper(): Promise<StepResult> {
    for (let i = 0; i < 3; i++) {
      if (this.deps.probe.helperReady()) return { status: 'done', detail: `${userInfo().username} may run ${MACHINE_HELPER}'s setup commands` };
      const others = this.deps.probe.instances().filter((n) => n !== this.name);
      await this.question(
        `helper-${i}`,
        "Install the machine helper's setup commands (once per machine, as an admin)",
        `Every root step of setup is one command of the machine helper, run without a password by your login only. Review scripts/machine/${BRAND.cli}-machine.cjs, then run once in a terminal:\n\n  sudo bash ${join(ENGINE_ROOT, 'scripts', 'setup', 'machine-helper.sh')} --setup-user ${userInfo().username}${others.length ? ` ${others.join(' ')}` : ''}\n\nand answer done.`,
        ['done'],
      );
    }
    throw new OnboardError(`${userInfo().username} still may not run the helper's setup commands`);
  }

  private async stepRoot(step: StepId, command: string, args: string[], why: string, skipIf?: () => boolean): Promise<StepResult> {
    if (skipIf?.()) return { status: 'skipped', detail: 'already set up on this machine' };
    const r = await this.root(step, STEP_TITLES[step], why, command, args);
    return { status: 'done', detail: r.detail.split('\n').filter(Boolean).at(-1)?.slice(0, 300) ?? 'ran' };
  }

  private async stepAppKey(): Promise<StepResult> {
    const app = this.data('app');
    const inst = this.data('install');
    this.pem();
    const r = await this.root('app-key', STEP_TITLES['app-key'], `Installs the App's private key for wl-${this.name} only (0400) and checks it there, as credentials.sh github-app does. The copy staged for setup is deleted once it ran.`, 'install-app-key', [this.name, String(app.app_id), String(inst.installation_id), this.repo, app.mode === 'shared' ? 'shared' : 'per-repo']);
    dropSecret(this.dir, 'github-app-key');
    return { status: 'done', detail: r.detail.split('\n').filter(Boolean).at(-1)?.slice(0, 300) ?? 'installed' };
  }

  private async stepMerge(): Promise<StepResult> {
    const c = this.data('config');
    if (c.merged) return { status: 'skipped', detail: `${BRAND.configDir}/ is on ${c.default_branch} already` };
    await this.question('merge', `Review and merge the setup PR`, `${c.pr}\n\nThe coordinator's checkout, service and doctor need ${BRAND.configDir}/ on ${c.default_branch}. Adjust the config on the PR if needed, merge it yourself, then answer merged.`, ['merged']);
    return { status: 'done', detail: `merged ${c.pr}` };
  }

  private async stepDashboards(): Promise<StepResult> {
    const login = (await this.deps.owner.login()) ?? this.by;
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login)) throw new OnboardError(`no GitHub login for the dashboards (${login})`);
    const names = [...new Set([...this.deps.probe.instances(), this.name])].sort().slice(0, 20);
    return this.stepRoot('dashboards', 'install-dashboards', [login, ...names], `Each instance's dashboard, as its own coordinator, and the hub over them: ${names.join(', ')}. You sign in as @${login}.`);
  }

  private async claudeStatus(i: number): Promise<boolean> {
    const r = await this.root(`claude-status-${i}`, "Check the agent user's Claude sign-in (read-only)", `Runs claude auth status as wl-${this.name}-agent; nothing changes.`, 'claude-status', [this.name], { mayFail: true });
    try {
      const j = JSON.parse(r.output.slice(r.output.indexOf('{'))) as { loggedIn?: boolean };
      return j.loggedIn === true;
    } catch {
      return false;
    }
  }

  private async stepClaude(): Promise<StepResult> {
    const how = await this.question('claude-auth', `How do wl-${this.name}-agent's agents sign in to Claude?`, `subscription: a Claude subscription login, done once in a terminal (setup shows how). api-key: an Anthropic API key, billed per use. Either way, the daily budget of $${this.data('budget').usd} caps the estimated spend.`, ['subscription', 'api-key']);
    for (let i = 0; i < 3; i++) {
      if (how === 'subscription') {
        await this.question(
          `claude-login-${i}`,
          `Sign wl-${this.name}-agent in to Claude`,
          `In a terminal on this machine, run:\n\n  sudo bash /usr/local/libexec/${BRAND.cli}-setup/credentials.sh ${this.name} claude\n\nIn the session, run /login and follow the link with your Claude subscription account, then /exit. Then answer done; setup checks it.`,
          ['done'],
        );
      } else {
        const key = await this.secret(`claude-key-${i}`, 'claude-api-key', 'Paste an Anthropic API key', 'From console.anthropic.com, API keys. It is checked with one read-only call, then installed for the agent user only.', "the agent user's Claude Code (apiKeyHelper)", { fresh: i > 0 });
        if (!key) throw new OnboardError('no key pasted');
        const problem = await this.deps.anthropic(key.trim());
        if (problem) {
          dropSecret(this.dir, 'claude-api-key');
          continue;
        }
        await this.root(`claude-key-install-${i}`, 'Install the API key for the agent user', `credentials.sh ${this.name} api-key: the key on stdin, stored 0400 for wl-${this.name}-agent and read through apiKeyHelper; then credentials.yaml's agent_api_key points at it, so the runner and doctor use it. The staged copy is deleted.`, 'install-api-key', [this.name]);
      }
      if (await this.claudeStatus(i)) return { status: 'done', detail: `wl-${this.name}-agent is signed in (${how}); budget $${this.data('budget').usd}/day`, data: { how } };
    }
    throw new OnboardError(`wl-${this.name}-agent is still not signed in to Claude`);
  }

  private async stepDiscord(): Promise<StepResult> {
    const want = await this.question('discord', 'Add a Discord bot for work intake? (optional)', 'Intake turns reports in one Discord server into issues. Setting up the bot leaves intake off: you turn it on in intake.yaml when you want it.', ['set-up', 'skip']);
    if (want === 'skip') return { status: 'skipped', detail: 'no Discord bot' };
    for (let i = 0; i < 3; i++) {
      const token = await this.secret(`discord-token-${i}`, 'intake-discord', 'Paste the Discord bot token', 'Discord developer portal, your application, Bot, Reset Token. It is checked with read-only calls (who the bot is, its intents); no message is sent.', 'the coordinator only (credentials.sh intake-discord)', { fresh: i > 0 });
      if (!token) throw new OnboardError('no token pasted');
      let c = await this.deps.discord.check(token.trim());
      for (let j = 0; j < 3 && !c.ok && c.appId && !c.messageContent; j++) {
        await this.approve(`discord-intent-${i}-${j}`, 'Turn on the Message Content Intent', `${c.problem}. On the Bot page, under Privileged Gateway Intents, turn on Message Content Intent and save; then answer approved.`, developerPortal(c.appId));
        c = await this.deps.discord.check(token.trim());
      }
      if (!c.ok || !c.appId) {
        dropSecret(this.dir, 'intake-discord');
        if (i === 2) throw new OnboardError(`the Discord token: ${c.problem}`);
        continue;
      }
      await this.approve('discord-invite', `Invite ${c.botName ?? 'the bot'} to your server`, 'The invite asks only for View Channels, Send Messages, Send Messages in Threads and Read Message History. Pick the one server intake will read, then answer approved.', inviteUrl(c.appId));
      await this.root('discord-install', "Install the bot's token for the coordinator", `credentials.sh ${this.name} intake-discord: the token on stdin, 0400 for wl-${this.name} only. Intake stays off.`, 'install-discord-token', [this.name]);
      return { status: 'done', detail: `bot ${c.botName ?? c.appId} installed; intake stays off until you turn it on`, data: { discord_app: c.appId } };
    }
    throw new OnboardError('no working Discord token');
  }

  private async stepTailscale(): Promise<StepResult> {
    const want = await this.question(
      'tailscale',
      'How will you reach the dashboard from another machine?',
      `ssh-tunnel (the default; nothing changes on this machine): ssh -N -L ${HUB_PORT}:127.0.0.1:${HUB_PORT} <you>@<this machine>, then open the hub URL. tailscale: tailscale cert and tailscale serve make the hub reachable over HTTPS from your tailnet only (it still asks for its token); Tailscale must already be installed and logged in, as root.`,
      ['ssh-tunnel', 'tailscale'],
    );
    if (want !== 'tailscale') return { status: 'skipped', detail: `through an ssh tunnel to 127.0.0.1:${HUB_PORT}` };
    const port = await this.question('tailscale-port', 'The HTTPS port to serve the hub on, on the tailnet', '443 unless something else on this machine already serves it.', ['443', '8443', '10000']);
    const r = await this.root('tailscale-serve', 'tailscale cert and tailscale serve for the dashboard hub', `One helper command: tailscale cert for this node, then tailscale serve --bg --https=${port} to the hub on 127.0.0.1:${HUB_PORT}.`, 'tailscale-serve', [port]);
    await this.approve('tailscale-share', 'Share this machine with whoever should see the dashboard (optional)', 'In the Tailscale admin console, Machines, this machine, Share: invite by email. They see this node only, not your tailnet. Answer approved when done (or declined to skip).', 'https://login.tailscale.com/admin/machines').catch(() => null);
    return { status: 'done', detail: r.output.split('\n').filter(Boolean).at(-1) ?? 'serving' };
  }

  private async stepDoctor(): Promise<StepResult> {
    const attempt = this.steps().filter((s) => s.step === 'doctor').length;
    const r = await this.root(`doctor-${attempt}`, `${BRAND.cli} doctor for ${this.name}`, `Read-only: the instance's doctor, as wl-${this.name}, on its checkout.`, 'instance-doctor', [this.name, this.repo], { mayFail: true });
    this.report = onboardDoctor({ instanceDoctor: r.output, onboarding: this });
    const fails = this.report.filter((c) => c.level === 'fail');
    if (fails.length) throw new OnboardError(`doctor: ${fails.length} failing\n${fails.map((c) => `  FAIL ${c.name}: ${c.detail.split('\n')[0]}\n       fix: ${c.fix}`).join('\n')}`);
    return { status: 'done', detail: `all green (${this.report.length} checks${this.report.some((c) => c.level === 'warn') ? `, ${this.report.filter((c) => c.level === 'warn').length} warning(s)` : ''})` };
  }

  private plan(): Record<StepId, () => Promise<StepResult>> {
    const n = this.name;
    const ref = () => {
      const r = this.deps.engineRef();
      if (!r) throw new OnboardError(`can't tell which engine commit to install: run setup from the engine's git checkout`);
      return r;
    };
    return {
      app: () => this.stepApp(),
      install: () => this.stepInstall(),
      labels: () => this.stepLabels(),
      budget: () => this.stepBudget(),
      config: () => this.stepConfig(),
      ruleset: () => this.stepRuleset(),
      helper: () => this.stepHelper(),
      machine: () => this.stepRoot('machine', 'setup-machine', [], 'machine.sh: the roots, the shared agent slots (locks) and the sandbox dependencies. Once per machine.', () => this.deps.probe.exists(`/etc/${BRAND.cli}/slots.json`) && this.deps.probe.exists(`/var/lib/${BRAND.cli}/agent-slots`)),
      instance: () => this.stepRoot('instance', 'add-instance', [n], `instance.sh ${n}: wl-${n} (holds the credentials), wl-${n}-agent (holds nothing), their group, the checkout directory and the one sudoers rule letting wl-${n} start its agents.`, () => this.deps.probe.userExists(`wl-${n}`) && this.deps.probe.userExists(`wl-${n}-agent`)),
      engine: () => this.stepRoot('engine', 'install-engine', [ref(), n, this.repo], `engine.sh: the engine at commit ${ref().slice(0, 12)}, root-owned, and ${n}'s instance home as wl-${n}.`),
      'app-key': () => this.stepAppKey(),
      'budget-cap': () => this.stepRoot('budget-cap', 'set-budget', [n, String(this.data('budget').usd)], `As wl-${n}: the instance policy's daily budget, $${this.data('budget').usd}.`),
      merge: () => this.stepMerge(),
      checkout: () => this.stepRoot('checkout', 'checkout', [n, this.repo], `checkout.sh: wl-${n}'s clone through the App, agent-writable code but not git config or hooks, the secret-scan pre-commit hook, and the guardrail hooks for ${n}'s agent runs only (in wl-${n}'s instance home; nothing in the repo).`),
      service: () => this.stepRoot('service', 'install-service', [n], `service.sh ${n}: the coordinator as a system service, as wl-${n}, with its memory, CPU and task limits; it checks the instance first.`),
      dashboards: () => this.stepDashboards(),
      claude: () => this.stepClaude(),
      discord: () => this.stepDiscord(),
      tailscale: () => this.stepTailscale(),
      doctor: () => this.stepDoctor(),
    };
  }

  /** Run every step not done yet, in order. Stops at the first failure (recorded); a re-run continues there. */
  async run(): Promise<{ ok: boolean; error?: string; report: FixedCheck[] }> {
    const plan = this.plan();
    for (const step of STEP_ORDER) {
      if (this.done(step)) continue;
      try {
        const r = await plan[step]();
        this.record(step, r.status, r.detail, r.data);
      } catch (e) {
        const msg = (e as Error).message;
        this.record(step, 'failed', msg);
        return { ok: false, error: `${STEP_TITLES[step]}: ${msg}`, report: this.report };
      }
    }
    return { ok: true, report: this.report };
  }
}

const dirnameOf = (p: string) => join(p, '..');

/** Names of secrets still staged for a repo's onboarding (for the doctor and tests). */
export const leftoverSecrets = (dir: string) => stagedSecrets(dir);
