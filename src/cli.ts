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
