#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BRAND } from './brand.js';
import { ConfigInvalid, loadConfig } from './config/load.js';
import { doctor } from './doctor.js';
import { checkGuardrails } from './guardrails/check.js';
import { liveContext, refreshFingerprints } from './guardrails/context.js';
import { evaluate } from './guardrails/engine.js';
import { globToRegExp } from './guardrails/glob.js';
import { findProjectRoot, readStdin, runHook, type HookInput } from './hook.js';
import { install } from './install.js';
import { homeDir } from './os/index.js';
import { scanPath } from './scan/secrets.js';
import { checkVacuity } from './vacuity.js';
import { prodRead } from './prodread.js';
import { listJobs, queueJob, runJob } from './queue.js';
import { slotStatus } from './slots.js';
import { latestBaseline, recordBaseline } from './baseline.js';
import { createWorktree } from './worktrees.js';
import { runSkillEval, skillStatus } from './skilleval.js';
import { backlogFor, instanceId, logPath, runCoordinator, serviceLabel, status } from './service.js';
import { EventLog } from './events/log.js';
import { LABELS } from './backlog/types.js';
import { installService, uninstallService } from './os/index.js';
import { projectStateDir } from './guardrails/context.js';
import { fileURLToPath } from 'node:url';

const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };

const USAGE = `${BRAND.name} ${pkg.version}: ${BRAND.tagline}

usage: ${BRAND.cli} <command> [options]

  install [--git-hooks]            scaffold ${BRAND.configDir}/, merge hooks into .claude/settings.json
  doctor [--agentshield] [--json]  verify the install
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
  queue full-run [-- <command>]    queue the full test run; starts by itself when the machine-wide
                                   full-run slot is free and tests.yaml idle_probe passes
  jobs                             queued and finished runs, with log paths
  slots                            machine-wide agent slots in use (all harnesses) and the cap
  coordinator run [--once]         run the coordinator in the foreground (the service runs this)
  up | down                        install or remove the coordinator as a per-user service
                                   (launchd on macOS, systemd --user on Linux); survives sessions
  status                           what's running, waiting and spent, from the event log
  decide <id> <option>             answer a decision (also: a writer comments /${BRAND.cli} <option>)
  labels                           create the backlog labels on the GitHub repo
  prod-read '<SQL>'                one read-only query against production, through the
                                   read-only role (deploy.yaml prod_read); prints JSON
  hook <event>                     (called by Claude Code) pre-tool-use | stop | session-end

options: --root <dir> (default: nearest folder with ${BRAND.configDir}/, else cwd)`;

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
      const gitHooks = flag(args, '--git-hooks');
      const r = install({ root, gitHooks });
      console.log(`${r.scaffolded ? 'scaffolded' : 'kept'} ${BRAND.configDir}/; hooks merged into ${r.settingsPath}`);
      if (r.gitHook) console.log(`pre-commit secret scan: ${r.gitHook}`);
      for (const n of r.notes) console.log(`note: ${n}`);
      console.log(`next: ${BRAND.cli} doctor`);
      return 0;
    }

    case 'doctor': {
      const json = flag(args, '--json');
      const checks = doctor(root, { agentshield: flag(args, '--agentshield') });
      if (json) console.log(JSON.stringify(checks, null, 2));
      else for (const c of checks) console.log(`${c.level === 'ok' ? 'ok  ' : c.level === 'warn' ? 'WARN' : 'FAIL'}  ${c.name}: ${c.detail.replaceAll('\n', '\n        ')}`);
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
      const job = queueJob({ stateDir: projectStateDir(root), cwd: process.cwd(), command, idleProbe: cfg.tests.idle_probe, cliPath: fileURLToPath(import.meta.url) });
      console.log(`queued ${job.id}: ${command}\n  in ${job.cwd}\n  runner pid ${job.runnerPid} (detached; survives this session)\n  log ${job.log}\n  status: ${BRAND.cli} jobs`);
      return 0;
    }

    case 'skill': {
      if (sub === 'status') {
        const dir = join(root, BRAND.configDir, 'skills');
        for (const d of readdirSync(dir, { withFileTypes: true }).filter((x) => x.isDirectory())) console.log(`${skillStatus(join(dir, d.name)).padEnd(9)} ${d.name}`);
        return 0;
      }
      if (sub !== 'eval' || !rest[0]) {
        console.error('usage: skill eval <skill-dir> [--model m] [--judge m] | skill status');
        return 2;
      }
      const model = option(rest, '--model') ?? 'sonnet';
      const judge = option(rest, '--judge') ?? 'sonnet';
      const samples = Number(option(rest, '--samples') ?? 3);
      const r = runSkillEval(resolve(rest[0]), { model, judge, samples });
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
        const branch = cfg.project.project.default_branch;
        execFileSync('git', ['fetch', '-q', 'origin', branch], { cwd: root });
        const sha = execFileSync('git', ['rev-parse', `origin/${branch}`], { cwd: root, encoding: 'utf8' }).trim();
        const state = projectStateDir(root);
        const name = `baseline-${sha.slice(0, 8)}`;
        const wt = { repo: root, root: cfg.tests.worktree.root, stateDir: state, setup: cfg.tests.worktree.setup };
        const { path, setupErrors } = createWorktree(wt, name, `${BRAND.cli}/${name}`, sha);
        if (setupErrors.length) {
          console.error(`worktree setup failed: ${setupErrors.join('; ')}`);
          return 1;
        }
        const job = queueJob({
          stateDir: state,
          cwd: path,
          command: cfg.tests.runner.full,
          idleProbe: cfg.tests.idle_probe,
          cliPath: fileURLToPath(import.meta.url),
          after: { baseline: { eventsDb: logPath(root), sha, section: fmt.section, item: fmt.item, actor: instanceId() }, cleanup: { repo: root, root: cfg.tests.worktree.root, stateDir: state, name } },
        });
        console.log(`queued baseline run ${job.id} on ${branch} at ${sha.slice(0, 8)}\n  in ${path}\n  log ${job.log}\n  starts when no other full run is live; records the baseline when it finishes`);
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
      return runCoordinator(root, { once: rest.includes('--once') });
    }

    case 'up': {
      const cfg = loadConfig(root);
      const r = installService({
        label: serviceLabel(cfg),
        program: [process.execPath, fileURLToPath(import.meta.url), 'coordinator', 'run', '--root', root],
        workingDir: root,
        logFile: join(projectStateDir(root), 'coordinator.log'),
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' },
      });
      console.log(`${r.started ? 'started' : 'NOT started'}: ${r.detail}\n  ${r.path}\n  log ${join(projectStateDir(root), 'coordinator.log')}`);
      return r.started ? 0 : 1;
    }

    case 'down': {
      console.log(`removed ${uninstallService(serviceLabel(loadConfig(root)))}`);
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

    case 'labels': {
      const created = await backlogFor(loadConfig(root), root).ensureLabels([...LABELS]);
      console.log(created.length ? `created: ${created.join(', ')}` : 'all labels exist');
      return 0;
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
