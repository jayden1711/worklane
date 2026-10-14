#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { BRAND } from './brand.js';
import { ConfigInvalid, loadConfig } from './config/load.js';
import { doctor } from './doctor.js';
import { initCommand, MODES, type Mode } from './init.js';
import { exportBundle, importBundle, type ImportResult } from './instance-move.js';
import { hostname } from 'node:os';
import { checkGuardrails } from './guardrails/check.js';
import { liveContext, refreshFingerprints } from './guardrails/context.js';
import { evaluate } from './guardrails/engine.js';
import { globToRegExp } from './guardrails/glob.js';
import { findProjectRoot, readStdin, runHook, type HookInput } from './hook.js';
import { agentSettingsPath, guardrailSettings } from './agent-settings.js';
import { install, installCheckoutPrePush, installGitHook, invokedEngine } from './install.js';
import { recordPushBlocked } from './push-guard.js';
import { homeDir } from './os/index.js';
import { toolPath, toolPrefix } from './tool-path.js';
import { scanPath } from './scan/secrets.js';
import { checkVacuity } from './vacuity.js';
import { prodRead } from './prodread.js';
import { listJobs, queueJob, runJob } from './queue.js';
import { emergencyStop, resumeAll, slotStatus, stopAll } from './slots.js';
import { latestBaseline, recordBaseline } from './baseline.js';
import { runnerAsk, runSkillEval, SKILL_EVAL_DEFAULTS, skillStatus } from './skilleval.js';
import { lintSkills, SKILL_SECTIONS, skillLintReport, trackedSkills } from './skill-lint.js';
import { CliRunner } from './runner.js';
import { queueBaselineRun } from './nightly.js';
import { APP_KEY_ROTATE_DAYS, appKeyAge, appKeyWarning, buildReport, tokenWarning } from './reports.js';
import { dashboardSite, DEFAULT_WEB_DIR, instancePort, startDashboard, webUiBuilt } from './dashboard.js';
import { HUB_BREAK_GLASS_PORT, HUB_PORT, parseHubArg, signInFromFiles, startHub } from './dashboard-hub.js';
import { parseDeviceList } from './console/terminal-devices.js';
import { breakGlassHub, runAppManifest, VIEWER_USER } from './setup/app-manifest.js';
import { seedDemo } from './demo.js';
import { desktopBinary, runDesktop } from './desktop.js';
import { credentialProblems, initInstance, instanceFilesProblem, instanceProblems, instancesDir, listInstances, loadInstance, loadInstanceCredentials, loadInstanceSetup, policiesForRepo, setGithubApp } from './instance.js';
import { readServerAutoConfig, serverAutoConfig, type ServerAutoConfigLine } from './server-auto-config.js';
import { canaryRefusal, checkCanary, fileCanary } from './canary.js';
import { applyMigrations, instanceTargets, MigrationFailed, planMigrations, projectConfigFiles } from './migrations.js';
import { appBotIdentity, installationTokens } from './github-app.js';
import { tune } from './tune.js';
import { scanStuck } from './stuck.js';
import { homeOf, openUrl, stateDir } from './os/index.js';
import { backlogFor, instanceEnv, instanceTokens, instanceId, instanceServiceLabel, localServiceSpec, logPath, runCoordinator, runInstanceCoordinator, serviceLabel, status, writeInstanceHooks } from './service.js';
import { checkRepoScope } from './github-scope.js';
import { EventLog } from './events/log.js';
import { LABELS } from './backlog/types.js';
import { INTAKE_LABEL } from './intake/github.js';
import { discordChannelsCommand } from './intake/discord-channels.js';
import { installService, uninstallService } from './os/index.js';
import { projectStateDir } from './guardrails/context.js';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

const USAGE = `${BRAND.name} ${pkg.version}: ${BRAND.tagline}

usage: ${BRAND.cli} <command> [options]

  init [<repo>] [--mode local|server] [--yes] [--reset] [--instance name] [--answer id=choice] [--timeout min]
                                   the guided first setup, one checklist in order: tools, Claude login,
                                   GitHub, repo config, (on a server) the coordinator running, protection,
                                   then Discord (and Tailscale on a server), optional. Each step is checked
                                   before the next; rerun it to pick up where it stopped. Asks for the mode
                                   when not given. local: this checkout (default: here), as you; server:
                                   <owner/repo>, as root, through scripts/setup/add-project.sh (--timeout:
                                   how long it waits for a GitHub click or the setup PR's merge). --yes
                                   installs missing tools as shown. Run through npx (npx ${BRAND.pkg} init),
                                   local mode first installs the engine under ~/.local, then goes on from there
  export [--instance name] [--out file]
                                   one file with this checkout's (or instance's) config and history (the
                                   event log, init's checklist, findings); never secrets, locks or logs
  import <file> [--instance name] [--force]
                                   take an export here (a laptop's, onto a server: no ssh between them);
                                   refuses a target with history of its own unless --force
  install [--instance name] [--git-hooks] [--engine path] | install --git-hooks-only
                                   scaffold ${BRAND.configDir}/; with --instance, write the hooks and rules
                                   for that instance's agent runs only (in its home); without, merge them
                                   into .claude/settings.json for local runs
  doctor [--agentshield] [--json] [--policy file] [--instance name] [--mode local|server]
                                   verify the install, and the config against any local instance's policy;
                                   init's checklist, and what the mode can't do
  guardrails check                 run rules against their must-block/ask/allow examples
  guardrails refresh               fetch production fingerprints (stores hashes only)
  guardrails eval '<command>'      show what the rules decide for a shell command
  vacuity [files...]               flag tests that assert nothing or touch no app code
                                   (default: test files changed vs the default branch)
  scan transcripts [dir]           secret-scan Claude Code transcripts for this project
  baseline record --log <file> --sha <sha>
                                   record main's failing set from a full run's output
  baseline record --queue          queue a full run on the tip of main; records the baseline when done
  baseline show                    main's recorded failing set
  skill eval <skill-dir> [--model m] [--judge m] [--samples k]
                                   run a skill's evals (evals/cases.md); writes evals/results.json
  skill status                     each project skill: evaluated, failing, stale or draft
  skill lint                       every SKILL.md has When to use, Inputs and access, Steps, Validate,
                                   Return and Approval, none empty; exits 1 otherwise (for CI)
  queue full-run [--max-load n] [-- <command>]
                                   queue the full test run; starts by itself when the machine-wide
                                   full-run slot is free and tests.yaml idle_probe passes
  jobs                             queued and finished runs, with log paths
  slots                            machine-wide agent slots in use (all harnesses) and the cap
  stop-all [reason]                emergency stop: halt every agent on this machine, across
                                   instances; tasks requeue. resume-all lifts it
  coordinator run [--once] [--instance name]
                                   run the coordinator in the foreground (the service runs this)
  up | down [--instance name]      install or remove the coordinator as a per-user service
                                   (launchd on macOS, systemd --user on Linux); survives sessions
  dashboard [--instance name] [--port n] [--user login] [--no-open] [--app]
                                   the live dashboard on 127.0.0.1 (reads the event log; with
                                   --instance, that instance's, as its coordinator user); its
                                   token is the owner's break-glass (--user: the login recorded)
  dashboard --hub name=<state dir>[,...] [--port n] [--break-glass-port n] [--service]
            [--console-user admin --console-devices tag:x,node]
            [--client-id id --public-url https://<host> --signin-dir dir]
                                   one view over several instances' own dashboards; it forwards
                                   to each, so writes stay with that instance's server and user.
                                   People sign in with GitHub (the sign-in App's client id; its
                                   secrets in --signin-dir); the token works on the break-glass
                                   port only, on this machine (docs/dashboard.md);
                                   --console-user: the admin user the owner terminal runs as
                                   from the Tailscale devices --console-devices lists (none: refused)
  demo <dir>                       seed a demo project worked by the real coordinator, then
                                   open its dashboard: dashboard --root <dir>/shop
  report                           the report the coordinator would post now (since the last one)
  tune <instance> [--full] [--dry-run]
                                   profile the test suite at 1/2/4/all cores' workers and open a PR
                                   with the recommended worker settings (run as the coordinator user)
  canary file|check --instance name --repo owner/repo [--reason update|daily] [--issue n] --json
                                   (the engine updater runs these as the canary instance's user) file the
                                   canary issue on the scratch repo, or say how far it got (docs/canary.md)
  migrate [--instance name]        apply pending config and state migrations, each file backed up first
                                   (doctor lists them; the coordinator won't start while any is pending)
  status                           what's running, waiting and spent, from the event log
  stuck-scan [--instance name]     read-only: how many recorded runs the stuck-run guard would have
                                   flagged or stopped (run as the coordinator user)
  decide <id> <option>             answer a decision (also: a writer comments /${BRAND.cli} <option>)
  labels                           create the backlog labels on the GitHub repo
  discord channels [--instance name]
                                   read-only: the text and announcement channels the instance's bot can see,
                                   one "<server> / #<channel> <id>" line each (run as the instance's user)
  instance init <name> --repo <path> --github <owner/repo>
                                   create an instance home (policy, credential references, state)
  instance list | show <name>      instances on this machine; show checks policy and credentials
  instance set-github-app <name> --app-id <n> --installation-id <n> --key <path>
                                   point credentials.yaml at the instance's App (credentials.sh github-app runs it)
  instance auto-config <name> [--answer <id>=<choice>]...
                                   server mode's repo config: detect, check as the agent user, propose the setup PR
                                   through the App; one JSON line says where it stands (checkout.sh runs it)
  app-manifest <name> <owner/repo> [--signin] [--public-url https://<host>] [--timeout <minutes>] [--ask-lines]
                                   (as root) make a GitHub App through the hub's manifest flow: prints the
                                   approve links and waits. The agent App: its key for the coordinator only,
                                   installed on <owner/repo> alone, checked, then credentials.yaml. --signin:
                                   the dashboard's sign-in App, its client secret for the hub's user only
  prod-read '<SQL>'                one read-only query against production, through the
                                   read-only role (deploy.yaml prod_read); prints JSON
  hook <event>                     (called by Claude Code) pre-tool-use | stop | session-end

options: --root <dir> (default: nearest folder with ${BRAND.configDir}/, else cwd)`;

/** One command's lines of USAGE (its synopsis and description). */
function commandUsage(name: string, usage = USAGE): string {
  const lines = usage.split('\n');
  const at = lines.findIndex((l) => l.startsWith(`  ${name} `) || l === `  ${name}`);
  if (at < 0) return usage;
  const end = lines.findIndex((l, i) => i > at && !/^ {4,}\S/.test(l));
  return [`usage: ${BRAND.cli} ${lines[at]!.trim()}`, ...lines.slice(at + 1, end < 0 ? undefined : end)].join('\n');
}

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}
function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function changedTestFiles(root: string, globs: string[], branch: string): string[] {
  const base = execFileSync('git', ['merge-base', `origin/${branch}`, 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const files = execFileSync('git', ['diff', '--name-only', '--diff-filter=AM', base], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
  const res = globs.map((g) => globToRegExp(g));
  return files.filter((f) => res.some((re) => re.test(f)) && existsSync(join(root, f)));
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const rootOpt = option(args, '--root');
  const instanceOpt = option(args, '--instance');
  const root = resolve(rootOpt ?? findProjectRoot(process.cwd()) ?? process.cwd());
  const [cmd, sub, ...rest] = args;

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    case '--version':
    case '-v':
      console.log(pkg.version);
      return 0;

    case 'hook': {
      const raw = await readStdin();
      let input: HookInput = {};
      try {
        input = raw.trim() ? (JSON.parse(raw) as HookInput) : {};
      } catch {
        process.stderr.write(`[${BRAND.cli}] hook input is not JSON\n`);
        return 2;
      }
      const out = await runHook(sub ?? '', input);
      if (out.stdout) process.stdout.write(out.stdout);
      if (out.stderr) process.stderr.write(out.stderr);
      return out.exitCode;
    }

    case 'install': {
      // Only the pre-commit secret scan, e.g. in a checkout whose settings are already committed.
      if (flag(args, '--git-hooks-only')) {
        console.log(`pre-commit secret scan: ${installGitHook(root)}`);
        // An instance's checkout (checkout.sh): never a push of the default branch from it, by anyone. The config's
        // branch when the repo has its config yet; origin/HEAD's at push time either way.
        let branches: string[] = [];
        try {
          branches = [loadConfig(root).project.project.default_branch];
        } catch {
          // no config yet: the hook goes by origin/HEAD
        }
        console.log(`pre-push default-branch guard: ${installCheckoutPrePush(root, branches, invokedEngine())}`);
        return 0;
      }
      const gitHooks = flag(args, '--git-hooks');
      // A machine-wide engine (e.g. /opt/<cli>/current/...): hooks call that stable path, not this run's versioned one.
      // An instance's agents: hooks and rules in its agent settings, for its agent runs only, not in the checkout.
      const instance = instanceOpt;
      // For an instance, the engine as invoked (a stable path), unless named.
      const engineCli = option(args, '--engine') ?? (instance ? invokedEngine() : undefined);
      const r = install({ root, gitHooks, ...(engineCli ? { engineCli } : {}), ...(instance ? { instance } : {}) });
      console.log(`${r.scaffolded ? 'scaffolded' : 'kept'} ${BRAND.configDir}/; hooks ${instance ? `for ${instance}'s agent runs written to` : 'merged into'} ${r.settingsPath}`);
      if (r.gitHook) console.log(`pre-commit secret scan: ${r.gitHook}`);
      for (const n of r.notes) console.log(`note: ${n}`);
      console.log(`next: ${BRAND.cli} doctor`);
      return 0;
    }

    case 'migrate': {
      // Each pending step, after a backup beside its file; the instance's files and repo config with --instance.
      const targets = instanceOpt ? instanceTargets(join(instancesDir(), instanceOpt)) : { configFiles: projectConfigFiles(root), eventsDb: logPath(root) };
      // --json: for the engine updater, which migrates each instance as part of installing an engine and restores
      // these backups if anything after fails.
      const json = flag(args, '--json');
      const plan = planMigrations(targets);
      if (plan.newer.length) {
        const error = `${plan.newer.join('\n')}\nnewer than this engine: nothing migrated. Update the engine, or restore a backup.`;
        if (json) console.log(JSON.stringify({ ok: false, error, made: [] }));
        else console.error(error);
        return 1;
      }
      let r: ReturnType<typeof applyMigrations>;
      try {
        r = applyMigrations(targets);
      } catch (e) {
        const restored = e instanceof MigrationFailed ? e.restored : [];
        if (json) console.log(JSON.stringify({ ok: false, error: (e as Error).message, made: [], restored }));
        else console.error(`migration failed: ${(e as Error).message}`);
        return 1;
      }
      if (json) {
        console.log(JSON.stringify({ ok: true, applied: r.applied.map((p) => ({ kind: p.kind, path: p.path, from: p.from, to: p.to })), made: r.made }));
        return 0;
      }
      if (!r.applied.length) console.log('nothing to migrate: config and state are at the current versions');
      for (const [k, p] of r.applied.entries()) console.log(`migrated ${p.path}: ${p.kind} version ${p.from} -> ${p.to} (${p.steps.join('; ')}); backup ${r.backups[k]}`);
      if (r.applied.some((p) => p.kind === 'config' && !p.path.startsWith(instanceOpt ? join(instancesDir(), instanceOpt) : '\0'))) console.log(`the repo's ${BRAND.configDir}/ changed: commit it in a PR`);
      return 0;
    }

    case 'init': {
      if (flag(args, '--help') || flag(args, '-h')) {
        console.log(commandUsage('init'));
        return 0;
      }
      const modeOpt = option(args, '--mode');
      if (modeOpt !== undefined && !(MODES as readonly string[]).includes(modeOpt)) {
        console.error('init: --mode is local or server');
        return 2;
      }
      const yes = flag(args, '--yes');
      const reset = flag(args, '--reset');
      // Auto-config's questions, answered up front: --answer <id>=<choice> (or <id>=custom:<command>), repeatable.
      const answers: Record<string, string> = {};
      for (let a = option(args, '--answer'); a !== undefined; a = option(args, '--answer')) {
        const eq = a.indexOf('=');
        if (eq < 1) {
          console.error(`init: --answer takes <id>=<choice>, not "${a}"`);
          return 2;
        }
        answers[a.slice(0, eq)] = a.slice(eq + 1);
      }
      // Server mode: how long add-project waits for a GitHub click or the setup PR's merge (minutes).
      const timeoutOpt = option(args, '--timeout');
      if (timeoutOpt !== undefined && !/^[1-9][0-9]{0,2}$/.test(timeoutOpt)) {
        console.error('init: --timeout is minutes, 1 to 999');
        return 2;
      }
      const target = args[1]?.startsWith('-') ? undefined : args[1];
      const unknown = args.slice(target ? 2 : 1);
      if (unknown.length) {
        console.error(`init: unexpected ${unknown.join(' ')}`);
        return 2;
      }
      return initCommand({ target: target ?? rootOpt, mode: modeOpt as Mode | undefined, instance: instanceOpt, yes, reset, cwd: root, prefix: toolPrefix(), interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY), ...(Object.keys(answers).length ? { answers } : {}), ...(timeoutOpt ? { timeout: Number(timeoutOpt) } : {}) });
    }

    case 'export': {
      const out = option(args, '--out');
      let site: { stateDir: string; root: string; repo: string | null; name: string };
      if (instanceOpt) {
        const i = loadInstance(instanceOpt);
        site = { stateDir: i.stateDir, root: i.repo.path, repo: i.config.project.project.repo, name: i.name };
      } else {
        let repo: string | null = null;
        try {
          repo = loadConfig(root).project.project.repo;
        } catch {
          // a checkout without config: its history only
        }
        site = { stateDir: projectStateDir(root), root, repo, name: basename(root) };
      }
      const file = resolve(out ?? `${BRAND.cli}-${site.name}-${new Date().toISOString().slice(0, 10)}.bundle`);
      const r = exportBundle({ stateDir: site.stateDir, root: existsSync(site.root) ? site.root : null, repo: site.repo, host: hostname(), out: file });
      console.log(`exported ${r.files.length} files to ${r.file} (yours only, 0600)`);
      for (const l of r.left) console.log(`  left out ${l.path}: ${l.why}`);
      console.log(`on the other machine: ${BRAND.cli} import ${basename(r.file)}${instanceOpt ? '' : ' --instance <name>'} (as that instance's coordinator user, with it stopped)`);
      return 0;
    }

    case 'import': {
      const file = args[1];
      const force = flag(args, '--force');
      if (!file || file.startsWith('-')) {
        console.error('usage: import <file> [--instance name] [--force]');
        return 2;
      }
      const target = instanceOpt ? (() => { const i = loadInstance(instanceOpt); return { stateDir: i.stateDir, root: i.repo.path }; })() : { stateDir: projectStateDir(root), root };
      let r: ImportResult;
      try {
        r = importBundle({ file: resolve(file), stateDir: target.stateDir, root: existsSync(target.root) ? target.root : null, instance: Boolean(instanceOpt), force });
      } catch (e) {
        console.error(`import: ${(e as Error).message}`);
        return 1;
      }
      console.log(`imported ${r.state.length} state files into ${target.stateDir}${r.config.length ? `, and ${r.config.length} config files into ${join(target.root, BRAND.configDir)}` : ''}`);
      for (const s of r.skipped) console.log(`  skipped ${s.path}: ${s.why}`);
      if (r.configDiffers.length) console.log(`the checkout's config differs from the bundle's in: ${r.configDiffers.join(', ')}; the config is the repo's: commit what you want of it in a PR`);
      console.log(`next: ${BRAND.cli} doctor${instanceOpt ? ` --instance ${instanceOpt}` : ''} (pending migrations of an older history show there)`);
      return 0;
    }

    case 'canary': {
      // Only the canary instance's own repo, named again by the machine config, and never a repo another instance runs on.
      const repo = option(args, '--repo') ?? '';
      const reason = option(args, '--reason') === 'update' ? 'update' : 'daily';
      const issue = Number(option(args, '--issue'));
      const out = (j: unknown) => (console.log(JSON.stringify(j)), 0);
      if (!instanceOpt || (sub !== 'file' && sub !== 'check') || (sub === 'check' && !(Number.isInteger(issue) && issue > 0))) {
        console.error(`usage: ${BRAND.cli} canary file|check --instance <name> --repo <owner/repo> [--reason update|daily] [--issue <n>] --json`);
        return 2;
      }
      try {
        const i = loadInstance(instanceOpt);
        const refusal = canaryRefusal({ instance: i.name, instanceRepo: i.repo.repo, canaryRepo: repo, others: policiesForRepo(repo).map((p) => ({ name: p.name, repo })) });
        if (refusal) return (out({ ok: false, error: refusal }), 1);
        const backlog = backlogFor(i.config, i.repo.path, i.stateDir, instanceTokens(i, instanceEnv(i)));
        if (sub === 'file') return out({ ok: true, ...(await fileCanary(backlog, repo, reason, new Date())) });
        const log = new EventLog(join(i.stateDir, 'events.db'));
        try {
          return out({ ok: true, ...(await checkCanary(backlog, repo, issue, log.read(0, ['issue.seen', 'issue.claimed', 'plan.posted', 'pr.opened', 'pr.closed']))) });
        } finally {
          log.close();
        }
      } catch (e) {
        return (out({ ok: false, error: String((e as Error).message ?? e).split('\n')[0]!.slice(0, 500) }), 1);
      }
    }

    case 'doctor': {
      const json = flag(args, '--json');
      const policy = option(args, '--policy');
      const modeOpt = option(args, '--mode');
      if (modeOpt !== undefined && !(MODES as readonly string[]).includes(modeOpt)) {
        console.error('doctor: --mode is local or server');
        return 2;
      }
      const instance = instanceOpt;
      const checks = doctor(root, { agentshield: flag(args, '--agentshield'), ...(policy ? { policy } : {}), ...(instance ? { instance } : {}), ...(modeOpt ? { mode: modeOpt as Mode } : {}) });
      if (json) console.log(JSON.stringify(checks, null, 2));
      else for (const c of checks) console.log(`${c.level === 'ok' ? 'ok  ' : c.level === 'warn' ? 'WARN' : c.level === 'off' ? 'off ' : 'FAIL'}  ${c.name}: ${c.detail.replaceAll('\n', '\n        ')}`);
      return checks.some((c) => c.level === 'fail') ? 1 : 0;
    }

    case 'guardrails': {
      const cfg = loadConfig(root);
      if (sub === 'check') {
        const problems = checkGuardrails(cfg.guardrails, root);
        for (const p of problems) console.error(`FAIL ${p.kind}: ${p.example ?? p.rule}: ${p.message}`);
        if (!problems.length) console.log(`guardrails: ${cfg.guardrails.rules.length} rules consistent with all examples`);
        return problems.length ? 1 : 0;
      }
      if (sub === 'refresh') {
        const results = refreshFingerprints(root, cfg.guardrails);
        for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}: ${r.ok ? `${r.count} fingerprint(s) stored` : r.error}`);
        return results.every((r) => r.ok) ? 0 : 1;
      }
      if (sub === 'eval') {
        const agent = flag(rest, '--agent');
        const command = rest.join(' ');
        const ctx = { ...liveContext(root), agent };
        const v = evaluate({ tool: 'Bash', input: { command }, cwd: process.cwd() }, cfg.guardrails, ctx);
        console.log(v.decision === 'none' ? 'none (no rule objects)' : `${v.decision}: ${v.rule}: ${v.reason}`);
        return 0;
      }
      console.error('usage: guardrails check | refresh | eval <command>');
      return 2;
    }

    case 'vacuity': {
      const cfg = loadConfig(root);
      const v = cfg.tests.vacuity;
      if (!v) {
        console.error(`tests.yaml has no vacuity section`);
        return 2;
      }
      const files = sub ? [sub, ...rest] : changedTestFiles(root, v.test_globs, cfg.project.project.default_branch);
      let bad = 0;
      for (const f of files) {
        const r = checkVacuity(root, f, { assertionPattern: v.assertion_pattern, appPaths: v.app_paths, dynamic: v.dynamic, runOne: cfg.tests.runner.one });
        if (r.vacuous) bad++;
        console.log(`${r.vacuous ? 'VACUOUS' : 'ok     '} ${f}: ${r.assertions} assertion(s)${r.touched ? `, touched ${r.touched.length} app file(s)` : ''}${r.why.length ? ` (${r.why.join('; ')})` : ''}`);
      }
      if (!files.length) console.log('no test files to check');
      return bad ? 1 : 0;
    }

    case 'scan': {
      if (sub !== 'transcripts') {
        console.error('usage: scan transcripts [dir]');
        return 2;
      }
      const dir = rest[0] ?? join(homeDir(), '.claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
      if (!existsSync(dir)) {
        console.error(`no transcripts at ${dir}`);
        return 2;
      }
      const files = statSync(dir).isDirectory() ? readdirSync(dir).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, f)) : [dir];
      let leaks = 0;
      for (const f of files) {
        const r = scanPath(f);
        if (r.status === 'unavailable') {
          console.error(`FAIL scanner unavailable: ${r.error}`);
          return 2;
        }
        if (r.status === 'leaks') {
          leaks += r.findings.length;
          for (const x of r.findings) console.log(`LEAK ${f}:${x.line} ${x.rule}`);
        }
      }
      console.log(`${files.length} transcript(s) scanned, ${leaks} finding(s)`);
      return leaks ? 1 : 0;
    }

    case 'queue': {
      if (sub !== 'full-run') {
        console.error('usage: queue full-run [-- <command>]');
        return 2;
      }
      const cfg = loadConfig(root);
      const dash = rest.indexOf('--');
      const command = dash >= 0 ? rest.slice(dash + 1).join(' ') : cfg.tests.runner.full;
      const maxLoadOpt = option(rest, '--max-load');
      const job = queueJob({ stateDir: projectStateDir(root), cwd: process.cwd(), command, idleProbe: cfg.tests.idle_probe, maxLoad: maxLoadOpt ? Number(maxLoadOpt) : undefined, cliPath: fileURLToPath(import.meta.url) });
      console.log(`queued ${job.id}: ${command}\n  in ${job.cwd}\n  runner pid ${job.runnerPid} (detached; survives this session)\n  log ${job.log}\n  status: ${BRAND.cli} jobs`);
      return 0;
    }

    case 'skill': {
      if (sub === 'status') {
        const dir = join(root, BRAND.configDir, 'skills');
        for (const d of readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory())) console.log(`${skillStatus(join(dir, d.name)).padEnd(9)} ${d.name}`);
        return 0;
      }
      if (sub === 'lint') {
        // Every tracked SKILL.md in the repo; exits 1 if any fails, so a project's own CI can run it.
        const bad = lintSkills(root);
        if (bad.length) console.error(skillLintReport(bad));
        else console.log(`skill lint: ${trackedSkills(root).length} SKILL.md file(s) pass (${SKILL_SECTIONS.join(', ')})`);
        return bad.length ? 1 : 0;
      }
      if (sub !== 'eval' || !rest[0]) {
        console.error('usage: skill eval <skill-dir> [--model m] [--judge m] | skill status | skill lint');
        return 2;
      }
      const model = option(rest, '--model') ?? SKILL_EVAL_DEFAULTS.model;
      const judge = option(rest, '--judge') ?? SKILL_EVAL_DEFAULTS.judge;
      const samples = Number(option(rest, '--samples') ?? SKILL_EVAL_DEFAULTS.samples);
      // Through the runner like every run: one claude per login, the subscription CLI, each call's cost recorded.
      const cfg = loadConfig(root);
      const log = new EventLog(logPath(root));
      const ask = runnerAsk(new CliRunner(cfg.project.agent_runtime.kind), (c) => log.append('run.cost', { issue: null, role: 'skill-eval', model: c.model, usd: c.costUsd, turns: c.turns }, instanceId()));
      let r;
      try {
        r = await runSkillEval(resolve(rest[0]), { model, judge, samples, ask });
      } finally {
        log.close();
      }
      for (const c of r.cases) console.log(`${c.pass ? 'pass' : 'FAIL'}  ${c.id}. ${c.title}  (${c.samples} samples passed${c.pass ? '' : `; e.g. correct ${c.correct}${c.wrongDone.length ? `, WRONG: ${c.wrongDone.join(' | ')}` : ''}`})`);
      console.log(`${r.passed}/${r.total} passed (model ${model}, judge ${judge})`);
      return r.passed === r.total ? 0 : 1;
    }

    case 'baseline': {
      const cfg = loadConfig(root);
      const fmt = cfg.tests.failures;
      if (sub === 'show') {
        const log = new EventLog(logPath(root));
        try {
          const b = latestBaseline(log);
          console.log(b ? `main baseline at ${b.sha} (recorded ${b.recordedAt}): ${b.failing.length} failing\n${b.failing.map((f) => `  - ${f}`).join('\n')}` : 'no baseline recorded');
        } finally {
          log.close();
        }
        return 0;
      }
      if (sub !== 'record') {
        console.error('usage: baseline record --log <file> --sha <sha> | baseline record --queue | baseline show');
        return 2;
      }
      if (!fmt) {
        console.error('tests.yaml needs a failures: { section, item } format to record a baseline');
        return 2;
      }
      if (rest.includes('--queue')) {
        const job = queueBaselineRun(root, cfg, logPath(root), instanceId(), cfg.project.governor.max_load);
        console.log(`queued baseline run ${job.id} on ${cfg.project.project.default_branch}\n  in ${job.cwd}\n  log ${job.log}\n  starts when no other full run is live and load allows; records the baseline when it finishes`);
        return 0;
      }
      const file = option(rest, '--log');
      const sha = option(rest, '--sha');
      if (!file || !sha) {
        console.error('usage: baseline record --log <file> --sha <sha>');
        return 2;
      }
      const log = new EventLog(logPath(root));
      try {
        const r = recordBaseline(log, instanceId(), sha, rest.includes('--passed') ? 0 : 1, readFileSync(file, 'utf8'), fmt);
        console.log(r.ok ? `recorded: ${r.failing.length} failing at ${sha.slice(0, 8)}` : `NOT recorded: ${r.why}`);
        return r.ok ? 0 : 1;
      } finally {
        log.close();
      }
    }

    case '_run-job': {
      const job = await runJob(sub!, rest[0]!);
      return job.status === 'passed' ? 0 : 1;
    }

    case 'jobs': {
      const jobs = listJobs(projectStateDir(root));
      for (const j of jobs) {
        console.log(`${j.id}  ${j.status.padEnd(7)}  ${j.command}${j.waitingFor ? `  (waiting: ${j.waitingFor})` : ''}${j.exitCode !== undefined ? `  exit ${j.exitCode}` : ''}\n    ${j.cwd}\n    log ${j.log}`);
      }
      if (!jobs.length) console.log('no jobs');
      return 0;
    }

    case 'slots': {
      const st = slotStatus();
      const halt = emergencyStop();
      if (halt) console.log(`EMERGENCY STOP in force since ${halt.at} by ${halt.by}: ${halt.reason}`);
      console.log(`agents running on this machine: ${st.agents.length} of ${st.cap}`);
      for (const a of st.agents) console.log(`  ${a.slot}: ${a.owner} (pid ${a.pid}, since ${a.acquiredAt})`);
      console.log(`full test run: ${st.fullRun ? `${st.fullRun.owner} (pid ${st.fullRun.pid}, since ${st.fullRun.acquiredAt})` : 'none'}`);
      return 0;
    }

    case 'coordinator': {
      if (sub !== 'run') {
        console.error('usage: coordinator run [--once]');
        return 2;
      }
      if (instanceOpt) return runInstanceCoordinator(instanceOpt, { once: rest.includes('--once') });
      return runCoordinator(root, { once: rest.includes('--once') });
    }

    case 'up': {
      if (instanceOpt) {
        const i = loadInstance(instanceOpt);
        const missing = credentialProblems(i.credentials);
        if (missing.length) {
          console.error(`instance ${i.name} not started; credentials missing:\n${missing.map((m) => `  ${m}`).join('\n')}`);
          return 1;
        }
        const r = installService({
          label: instanceServiceLabel(i.name),
          program: [process.execPath, fileURLToPath(import.meta.url), 'coordinator', 'run', '--instance', i.name],
          workingDir: i.home,
          logFile: join(i.stateDir, 'coordinator.log'),
          // Only what's needed to find tools and the instance; its credentials come from the instance itself.
          env: { PATH: toolPath(), HOME: process.env.HOME ?? '', ...(process.env[`${BRAND.envPrefix}_INSTANCES_DIR`] ? { [`${BRAND.envPrefix}_INSTANCES_DIR`]: process.env[`${BRAND.envPrefix}_INSTANCES_DIR`]! } : {}) },
        });
        console.log(`${r.started ? 'started' : 'NOT started'}: ${r.detail}\n  ${r.path}\n  log ${join(i.stateDir, 'coordinator.log')}`);
        return r.started ? 0 : 1;
      }
      const cfg = loadConfig(root);
      const r = installService(localServiceSpec(root, cfg));
      console.log(`${r.started ? 'started' : 'NOT started'}: ${r.detail}\n  ${r.path}\n  log ${join(projectStateDir(root), 'coordinator.log')}`);
      return r.started ? 0 : 1;
    }

    case 'down': {
      console.log(`removed ${uninstallService(instanceOpt ? instanceServiceLabel(instanceOpt) : serviceLabel(loadConfig(root)))}`);
      return 0;
    }

    case 'dashboard': {
      // No subcommand here: options start right after the command.
      const opts = [sub, ...rest].filter((x): x is string => x !== undefined);
      // --service: run under a service manager: no browser, and the token stays in its file, out of the log.
      const service = flag(opts, '--service');
      const hubArg = option(opts, '--hub');
      if (hubArg) {
        // One view over several instances, each served by its own dashboard as its own user (dashboard-hub.ts).
        const instances = parseHubArg(hubArg, instancePort);
        const hubState = join(stateDir(), 'dashboard-hub');
        const portOpt = option(opts, '--port');
        const bgOpt = option(opts, '--break-glass-port');
        const clientId = option(opts, '--client-id');
        const publicUrl = option(opts, '--public-url');
        const signinDir = option(opts, '--signin-dir');
        if ((clientId || publicUrl || signinDir) && !(clientId && publicUrl && signinDir)) throw new Error('sign-in needs all of --client-id, --public-url and --signin-dir');
        const signIn = clientId && publicUrl && signinDir ? signInFromFiles({ clientId, publicUrl, dir: signinDir }) : null;
        const h = await startHub({ instances, stateDir: hubState, port: portOpt ? Number(portOpt) : HUB_PORT, breakGlassPort: bgOpt ? Number(bgOpt) : HUB_BREAK_GLASS_PORT, signIn, terminal: { consoleUser: option(opts, '--console-user') ?? null, devices: parseDeviceList(option(opts, '--console-devices')) } });
        const bg = service ? `${h.breakGlassUrl.split('?')[0]} (token in ${join(hubState, 'dashboard-token')})` : h.breakGlassUrl;
        console.log(`${BRAND.name} dashboard hub for ${instances.map((i) => i.name).join(', ')}\n  sign-in: ${signIn ? `${signIn.publicUrl} (served on ${h.url})` : 'not set up (no --client-id)'}\n  break-glass, this machine only: ${bg}\n(loopback only)`);
        if (!service && !flag(opts, '--no-open')) openUrl(signIn ? signIn.publicUrl : h.breakGlassUrl);
        await new Promise(() => {});
        return 0;
      }
      const instance = instanceOpt;
      // An instance's log is readable only by its coordinator user: run this as that user.
      const site = dashboardSite(root, instance);
      const cfg = site.cfg;
      const portOpt = option(opts, '--port');
      const userOpt = option(opts, '--user');
      const noOpen = flag(opts, '--no-open');
      const app = flag(opts, '--app');
      let user = userOpt ?? process.env[`${BRAND.envPrefix}_USER`];
      // An instance's coordinator user has no personal GitHub login to ask: the owner unless --user says otherwise.
      if (!user && !instance) {
        try {
          user = execFileSync('gh', ['api', 'user', '--jq', '.login'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        } catch {
          // fall back to the owner
        }
      }
      user = user || cfg.project.owners.default;
      const d = await startDashboard({ root: site.root, logs: site.logs, policyFile: site.policyFile, backlog: site.backlog, cfg, eventsDb: site.eventsDb, stateDir: site.stateDir, user, port: portOpt ? Number(portOpt) : site.port, ...(site.roleOf ? { roleOf: site.roleOf } : {}), ...(instance ? { instance } : {}) });
      console.log(`${BRAND.name} dashboard for ${cfg.project.project.name}${instance ? ` (instance ${instance})` : ''}, as @${user}\n  ${service ? `${d.url.split('?')[0]} (token in ${join(site.stateDir, 'dashboard-token')})` : d.url}\n(local only; Ctrl+C to stop)`);
      if (!webUiBuilt()) console.error(`the web UI isn't built in this engine (no ${join(DEFAULT_WEB_DIR, 'index.html')}): run \`npm run build:web\` in it, or reinstall it with the engine setup script`);
      if (app) {
        const bin = desktopBinary();
        if (bin) {
          // The window owns the session: closing it stops the server.
          const code = await runDesktop(bin, d.url, `${cfg.project.project.name} · ${BRAND.name}`);
          await d.close();
          return code === 0 ? 0 : 1;
        }
        console.error(`desktop window not built (npm run build:desktop, or set ${BRAND.envPrefix}_DESKTOP); opening the browser instead`);
      }
      if (!noOpen && !service) openUrl(d.url);
      await new Promise(() => {});
      return 0;
    }

    case 'demo': {
      if (!sub) {
        console.error('usage: demo <new-dir>');
        return 2;
      }
      const r = await seedDemo(resolve(sub));
      console.log(`demo seeded: ${r.issues} issues worked by the real coordinator with scripted agents\n  project ${r.root}\n  open it: ${BRAND.cli} dashboard --root ${r.root} --user example-owner`);
      return 0;
    }

    case 'tune': {
      const name = sub;
      if (!name || name.startsWith('-')) {
        console.error('usage: tune <instance> [--full] [--dry-run]');
        return 2;
      }
      const i = loadInstance(name);
      const cfg = i.config;
      // As the coordinator does: the instance's own git credentials, hooks and commit identity, never the operator's.
      writeInstanceHooks(i);
      const env = instanceEnv(i);
      for (const k of Object.keys(process.env)) if (!(k in env)) delete process.env[k];
      Object.assign(process.env, env);
      const gh = i.credentials.github;
      const identity = i.commitIdentity ?? (gh.kind === 'app' ? await appBotIdentity({ appId: gh.app_id, installationId: gh.installation_id, keyPath: gh.key_path }) : { name: `${BRAND.cli}-${i.name}`, email: `${BRAND.cli}-${i.name}@users.noreply.invalid` });
      const main = cfg.project.project.default_branch;
      execFileSync('git', ['fetch', '-q', 'origin', main], { cwd: i.repo.path, stdio: 'inherit' });
      const base = execFileSync('git', ['rev-parse', `origin/${main}`], { cwd: i.repo.path, encoding: 'utf8' }).trim();
      const dryRun = flag(rest, '--dry-run');
      const r = await tune({
        wt: { repo: i.repo.path, root: cfg.tests.worktree.root, stateDir: i.stateDir, setup: cfg.tests.worktree.setup, ...(i.runAs ? { runAs: i.runAs } : {}), env: cfg.tests.env },
        tests: cfg.tests,
        base,
        mainBranch: main,
        full: flag(rest, '--full'),
        dryRun,
        limits: cfg.guardrails.push,
        ...(dryRun ? {} : { backlog: backlogFor(cfg, i.repo.path, i.stateDir, instanceTokens(i, env)) }),
        identity,
        stateDir: i.stateDir,
        onBlocked: (ref, head) => recordPushBlocked(join(i.stateDir, 'events.db'), ref, head, 'coordinator'),
      });
      console.log(`profiled \`${r.profile.command}\` on ${r.profile.cores} cores:`);
      for (const run of r.profile.runs) console.log(`  ${String(run.workers).padStart(3)} worker(s): ${run.ok ? `${run.seconds.toFixed(0)} s` : 'FAILED'}${run.peakWorkerMb ? `, ${run.peakWorkerMb.toFixed(0)} MB per worker` : ''}`);
      if (!r.recommendation) {
        console.log('no recommendation: no run passed');
        return 1;
      }
      console.log(`recommended: ${r.recommendation.workers} (${r.recommendation.why})`);
      if (r.refused) console.log(`push refused: ${r.refused.join('; ')}`);
      else if (r.pr) console.log(`opened ${r.pr.url}`);
      else console.log(r.changed ? 'dry run: the change is committed on a local branch, not pushed' : 'tests.yaml already has these settings');
      return r.refused ? 1 : 0;
    }

    case 'report': {
      const cfg = loadConfig(root);
      const log = new EventLog(logPath(root));
      try {
        const last = log.read(0, ['report.posted']).at(-1);
        console.log(buildReport(log.read(), cfg, { since: last ? new Date(last.ts) : new Date(Date.now() - 12 * 3_600_000) }).markdown);
      } finally {
        log.close();
      }
      return 0;
    }

    case 'stuck-scan': {
      const s = scanStuck(instanceOpt ? loadInstance(instanceOpt).stateDir : projectStateDir(root));
      console.log(`runs scanned: ${s.scanned} (${s.noFeed} older record(s) without a feed not scanned)\nwould flag: ${s.flagged}\nwould stop: ${s.stopped}`);
      for (const e of s.examples) console.log(`  ${e.kind} ${e.run}: ${e.tool} ${e.input}${e.failures ? ` (${e.failures} failure(s) in a row)` : ''}`);
      return 0;
    }

    case 'status': {
      console.log(status(root));
      return 0;
    }

    case 'decide': {
      const [id, answer] = [sub, rest[0]];
      if (!id || !answer) {
        console.error('usage: decide <decision-id> <option>');
        return 2;
      }
      const log = new EventLog(logPath(root));
      try {
        const q = log.read(0, ['decision.asked']).find((e) => (e.payload as { id: string }).id === id)?.payload as { options: string[] } | undefined;
        if (!q) {
          console.error(`no decision ${id}`);
          return 1;
        }
        if (!q.options.includes(answer)) {
          console.error(`options are: ${q.options.join(', ')}`);
          return 2;
        }
        log.append('decision.answered', { id, by: instanceId(), answer }, instanceId(), 'human');
        console.log(`recorded: ${id} -> ${answer} (the coordinator acts on its next tick)`);
        return 0;
      } finally {
        log.close();
      }
    }

    case 'git-credential': {
      // git's credential helper protocol, for an App instance's coordinator: hand git a fresh installation token.
      // git appends the action last: `git-credential [--instance <name>] get`.
      const args = [sub, ...rest].filter((a): a is string => a !== undefined);
      if (args.at(-1) !== 'get') return 0;
      const input = await readStdin();
      const host = /^host=(.*)$/m.exec(input)?.[1] ?? '';
      const api = new URL(process.env[`${BRAND.envPrefix}_GITHUB_API`] ?? 'https://api.github.com');
      if (host !== 'github.com' && host !== api.host) return 0; // not ours: let git try other helpers
      // A GitHub request this helper can't answer stops git (quit): it must never fall back to a terminal prompt.
      // The instance comes from the helper's own command line, then the environment, and then, because
      // `sudo -u` clears the environment, the coordinator user's only instance.
      const refuse = (why: string) => {
        console.error(`${BRAND.cli} git-credential: ${why}; not prompting for a password`);
        process.stdout.write('quit=1\n');
        return 0;
      };
      const mine = listInstances();
      // --instance on the helper's line is taken by the global option parser (instanceOpt) before this sees it.
      const name = instanceOpt ?? option(args, '--instance') ?? process.env[`${BRAND.envPrefix}_INSTANCE`] ?? (mine.length === 1 ? mine[0] : undefined);
      if (!name) return refuse(mine.length ? `this user has ${mine.length} instances; name one with --instance` : 'no instance for this user');
      const setUp = `set its GitHub App up first (credentials.sh ${name} github-app ..., or add-project's App step)`;
      try {
        const i = loadInstanceCredentials(name);
        const g = i.credentials.github;
        if (g.kind !== 'app') {
          // A gh-config-dir instance authenticates through gh's own helper; one whose gh dir isn't there has nothing
          // (instance init's placeholder): stop here rather than let git ask for a password it can't take.
          if (existsSync(g.path)) return 0;
          return refuse(`instance ${name}: credentials.yaml has no GitHub App, and no gh login at ${g.path}; ${setUp}`);
        }
        const tokens = installationTokens({ appId: g.app_id, installationId: g.installation_id, keyPath: g.key_path }, i.repos, i.stateDir, fetch, api.origin);
        process.stdout.write(`username=x-access-token\npassword=${await tokens()}\n`);
        return 0;
      } catch (e) {
        // Every problem, not ConfigInvalid's heading (the repo config folder "is invalid:", which named the wrong thing).
        return refuse(`instance ${name}: ${instanceFilesProblem(e)}; ${setUp}`);
      }
    }

    case 'push-blocked': {
      // The pre-push hook's record of a refused push to the default branch (push-guard.ts). Best effort: the hook
      // has refused the push already; this only writes the event, to the instance's log (the coordinator's git names
      // it in the environment) or else this checkout's.
      const args = [sub, ...rest].filter((a): a is string => a !== undefined);
      try {
        const name = process.env[`${BRAND.envPrefix}_INSTANCE`];
        const db = name ? join(loadInstanceCredentials(name).stateDir, 'events.db') : logPath(root);
        recordPushBlocked(db, option(args, '--ref') ?? '?', option(args, '--sha') ?? null, 'hook');
      } catch {
        // nowhere to record it: the refusal stands regardless
      }
      return 0;
    }

    case 'stop-all': {
      const reason = [sub, ...rest].filter(Boolean).join(' ') || 'emergency stop';
      stopAll(instanceId(), reason);
      console.log(`stop in force (${reason}): every coordinator halts its agents within seconds and starts none. Lift it with \`${BRAND.cli} resume-all\`.`);
      return 0;
    }

    case 'resume-all': {
      console.log(resumeAll() ? 'stop lifted: coordinators resume at their next check' : 'no stop was in force');
      return 0;
    }

    case 'instance': {
      if (sub === 'list') {
        for (const n of listInstances()) console.log(n);
        return 0;
      }
      const target = rest[0];
      if (sub === 'init' && target) {
        const repoPath = option(rest, '--repo');
        const gh = option(rest, '--github');
        if (!repoPath || !gh) {
          console.error('usage: instance init <name> --repo <path> --github <owner/repo> [--agent-user <user>] [--agent-home <dir>]');
          return 2;
        }
        const home = initInstance(target, repoPath, gh, undefined, option(rest, '--agent-user'), option(rest, '--agent-home'));
        console.log(`created ${home}\n  edit policy.yaml, and point credentials.yaml at credentials made for this instance`);
        return 0;
      }
      if (sub === 'show' && target) {
        const i = loadInstance(target);
        const missing = instanceProblems(i);
        let hooks = `agent runs only, from ${agentSettingsPath(i.home)}`;
        try {
          guardrailSettings(i.home, i.name, i.repo.path);
        } catch (e) {
          missing.push((e as Error).message);
          hooks = 'none';
        }
        console.log(`${i.name}: ${i.repo.repo} at ${i.repo.path}`);
        console.log(`  policy: budget $${i.policy.budget.daily_usd}/day, max ${i.policy.agents.max_workers} workers, land ${i.policy.land_mode}`);
        console.log(`  repo config: within policy`);
        const gh = i.credentials.github;
        console.log(`  github: ${gh.kind === 'app' ? `App ${gh.app_id}, installation ${gh.installation_id}, key ${gh.key_path}` : `gh config ${gh.path} (fallback: a personal access token)`}`);
        console.log(`  guardrail hooks: ${hooks}`);
        console.log(`  claude: ${i.runAs ? `${i.runAs.user}'s own login, in its home` : `config ${i.credentials.claude!.config_dir}`}`);
        for (const m of missing) console.log(`  MISSING ${m}`);
        if (missing.length) return 1;
        // The same repo-scope check the coordinator makes at start, without printing the token.
        let token = '';
        let failure = '';
        try {
          token = await instanceTokens(i, instanceEnv(i))();
        } catch (e) {
          failure = (e as Error).message.split('\n')[0]!;
        }
        const scope = token ? await checkRepoScope(token, [i.repo.repo], fetch, process.env[`${BRAND.envPrefix}_GITHUB_API`] ?? 'https://api.github.com') : { ok: false as const, why: `no GitHub token for the instance (${failure || 'empty'})` };
        if (!scope.ok) console.log(`  github token REFUSED: ${scope.why}`);
        else if (gh.kind === 'app') {
          // Installation tokens last about an hour and are minted again before they run out; the key is what ages.
          console.log(`  github token: ${scope.kind}, reaches only ${i.repo.repo}, not an admin; short-lived (about an hour), renewed automatically`);
          const age = appKeyAge(gh.key_path);
          console.log(`  App key: ${age === null ? 'age unknown' : `installed ${age} day(s) ago`} (App keys don't expire; rotate them after ${APP_KEY_ROTATE_DAYS} days)`);
        } else console.log(`  github token: ${scope.kind}${scope.login ? ` of ${scope.login}` : ''}, reaches only ${i.repo.repo}, not an admin; expires ${scope.expiresAt ?? 'never (set an expiry)'}`);
        const warn = !scope.ok ? null : gh.kind === 'app' ? appKeyWarning(appKeyAge(gh.key_path)) : tokenWarning(scope.expiresAt);
        if (warn) console.log(`  ${warn.replaceAll('**', '')}`);
        return scope.ok ? 0 : 1;
      }
      if (sub === 'set-github-app' && target) {
        // credentials.sh github-app, after its check passed: the App entry in credentials.yaml, validated, the rest kept.
        const [appId, installationId, key] = [Number(option(rest, '--app-id')), Number(option(rest, '--installation-id')), option(rest, '--key')];
        if (!Number.isInteger(appId) || appId <= 0 || !Number.isInteger(installationId) || installationId <= 0 || !key?.startsWith('/')) {
          console.error('usage: instance set-github-app <name> --app-id <n> --installation-id <n> --key <absolute path to the key>');
          return 2;
        }
        const file = join(instancesDir(), target, 'credentials.yaml');
        if (!existsSync(join(instancesDir(), target, 'instance.yaml'))) {
          console.error(`no instance "${target}" for this user (${join(instancesDir(), target)}): \`${BRAND.cli} instance init\` first`);
          return 1;
        }
        try {
          setGithubApp(file, { appId, installationId, keyPath: key }, 'by-hand');
        } catch (e) {
          console.error((e as Error).message);
          return 1;
        }
        console.log(`wrote ${file} (github: App ${appId}, installation ${installationId}; the rest kept)`);
        return 0;
      }
      if (sub === 'setup-status' && target) {
        // Read-only, from local files: whether the checkout has its config, and auto-config's setup PR and questions.
        try {
          const i = loadInstanceSetup(target);
          const s = readServerAutoConfig(i.stateDir);
          console.log(JSON.stringify({ config: existsSync(join(i.repo.path, BRAND.configDir, 'config.yaml')), pr: s.pr?.url ?? null, questions: s.questions.map((q) => q.id) }));
          return 0;
        } catch (e) {
          console.error(`instance ${target}: ${instanceFilesProblem(e)}`);
          return 1;
        }
      }
      if (sub === 'auto-config' && target) {
        // Server mode's repo config (src/server-auto-config.ts), as the coordinator user: one JSON line on stdout.
        const answers: Record<string, string> = {};
        for (let a = option(rest, '--answer'); a !== undefined; a = option(rest, '--answer')) {
          const eq = a.indexOf('=');
          if (eq < 1) {
            console.error(`instance auto-config: --answer takes <id>=<choice>, not "${a}"`);
            return 2;
          }
          answers[a.slice(0, eq)] = a.slice(eq + 1);
        }
        let line: ServerAutoConfigLine;
        try {
          line = await serverAutoConfig(target, Object.keys(answers).length ? { answers } : {});
        } catch (e) {
          line = { kind: 'failed', detail: `instance ${target}: ${instanceFilesProblem(e)}`, pr: null, questions: [] };
        }
        console.log(JSON.stringify(line));
        return line.kind === 'failed' ? 1 : 0;
      }
      console.error('usage: instance init <name> --repo <path> --github <owner/repo> [--agent-user <user>] [--agent-home <dir>] | instance list | instance show <name> | instance set-github-app <name> ... | instance auto-config <name> [--answer <id>=<choice>]...');
      return 2;
    }

    case 'app-manifest': {
      // The same flow the setup console runs, headless, for the setup scripts (src/setup/app-manifest.ts).
      const opts = [...rest];
      const signin = flag(opts, '--signin');
      // --ask-lines: each approve link also as one `ask: {json}` line, for add-project.sh to pass on as an ask.
      const askLines = flag(opts, '--ask-lines');
      const publicUrl = option(opts, '--public-url');
      const minutes = Number(option(opts, '--timeout') ?? 15);
      const tokenFile = option(opts, '--hub-token-file') ?? join(homeOf(VIEWER_USER) ?? homeDir(), '.local', 'state', BRAND.cli, 'dashboard-hub', 'dashboard-token');
      const port = Number(option(opts, '--break-glass-port') ?? HUB_BREAK_GLASS_PORT);
      const [repo, ...extra] = opts;
      if (!sub || !repo || extra.length || !Number.isFinite(minutes) || minutes <= 0 || !Number.isInteger(port)) {
        console.error(`usage: ${BRAND.cli} app-manifest <name> <owner/repo> [--signin] [--public-url https://<host>] [--timeout <minutes>] [--hub-token-file <file>] [--break-glass-port <n>]`);
        return 2;
      }
      let token: string;
      try {
        token = readFileSync(tokenFile, 'utf8').trim();
      } catch {
        console.error(`can't read the hub's token (${tokenFile}): is the dashboard hub running (dashboards.sh), and is this root?`);
        return 1;
      }
      const r = await runAppManifest({ instance: sub, repo, kind: signin ? 'signin' : 'agent', ...(publicUrl ? { publicUrl } : {}) }, { hub: breakGlassHub({ base: `http://127.0.0.1:${port}`, token }), timeoutMs: minutes * 60_000, log: (l) => console.log(l), ...(askLines ? { onAsk: (a) => void console.log(`ask: ${JSON.stringify({ kind: 'approve_link', title: a.title, detail: a.detail, url: a.url })}`) } : {}) });
      if (!r.ok) {
        console.error(`FAILED at "${r.step}": ${r.error}`);
        return 1;
      }
      console.log(`OK: App ${r.slug} (id ${r.appId})${r.installationId ? `, installation ${r.installationId}` : ''}`);
      return 0;
    }

    case 'labels': {
      const created = await backlogFor(loadConfig(root), root).ensureLabels([...LABELS, INTAKE_LABEL]);
      console.log(created.length ? `created: ${created.join(', ')}` : 'all labels exist');
      return 0;
    }

    case 'discord': {
      if (sub !== 'channels' || rest.length) {
        console.error(commandUsage('discord'));
        return 2;
      }
      return discordChannelsCommand({ instance: instanceOpt });
    }

    case 'prod-read': {
      const pr = loadConfig(root).deploy?.prod_read;
      if (!pr) {
        console.error('no production read path configured (deploy.yaml prod_read); production reads are off');
        return 2;
      }
      const r = prodRead(pr, [sub, ...rest].join(' '), root);
      if (!r.ok) {
        console.error(`prod-read failed: ${r.error}`);
        return 1;
      }
      console.log(r.output);
      return 0;
    }

    default:
      console.error(`unknown command: ${cmd}\n\n${USAGE}`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof ConfigInvalid ? e.message : `${BRAND.cli}: ${(e as Error).stack ?? String(e)}`);
    process.exit(e instanceof ConfigInvalid ? 1 : 2);
  },
);
