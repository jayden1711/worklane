#!/usr/bin/env node
// The agents' tool guard's own process (#665): every hook command install writes runs
// `node <engine>/dist/src/hook-main.js <event>` (src/install.ts hookCommand, src/instance.ts's research lanes).
//
// WHY its own entry: the hooks used to run `node <engine>/dist/src/cli.js hook <event>`. The CLI turns the guard's
// result into the exit code and loads some 400 modules, most of them outside the guard's locked tree, into the guard's
// process. This file is under src/hook*, and the tree it reaches is locked module by module (src/hook-imports.ts, held
// exact by test/review.test.ts), so what runs when an agent calls a tool is what the owner reviews.
//
// A PreToolUse call is decided under a deadline (src/hook-deadline.ts): this process holds it and runs no guard code;
// the guard decides in a child, this same file run with EVALUATE_ARG. The other events run here, as before.
//
// The CLI's `hook` command stays for installs written before this file: it runs the same hookProcess.
// INVARIANT: first, so node:sqlite's experimental warning never reaches stderr (quiet-sqlite.ts).
import './quiet-sqlite.js';
// INVARIANT: before any engine module: a <PREFIX>_SYSTEM_ROOT not honoured here stops the hook before anything starts.
import './os/system-root-guard.js';
import { writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BRAND } from './brand.js';
import { deliver, EVALUATE_ARG, refusal, underDeadline, VERDICT_FD, type GuardAnswer } from './hook-deadline.js';

const [first, second] = process.argv.slice(2);

// INVARIANT (#894 review): the holder exits only once its answer is written whole, or with exit 2 (deliver).
let answered = false;
const answer = (a: GuardAnswer) => {
  if (answered) return;
  answered = true;
  deliver(a);
};

if (first === 'pre-tool-use') {
  // Fails closed: anything that goes wrong in this process refuses the call, and while an answer is being delivered, exit 2.
  process.on('uncaughtException', (e) => (answered ? process.exit(2) : answer(refusal(`the tool guard failed (${e?.message ?? String(e)}); this tool call is refused`))));
  // INVARIANT: the evaluator is this file itself, by its own path: never a path from the call, the environment or a setting.
  void underDeadline({ file: process.execPath, args: [...process.execArgv, fileURLToPath(import.meta.url), EVALUATE_ARG, first] }, process.stdin).then(answer);
} else {
  const evaluating = first === EVALUATE_ARG;
  const event = (evaluating ? second : first) ?? '';
  import('./hook.js')
    .then(({ hookProcess }) => hookProcess(event))
    .then(async (code) => {
      if (evaluating) {
        // WHY: the answer reaches the holder whole before the verdict says it may be passed on (a pipe write can be queued).
        for (const s of [process.stdout, process.stderr]) await new Promise<void>((done) => s.write('', () => done()));
        // The verdict line the deadline's holder requires before it lets a call through (src/hook-deadline.ts).
        writeSync(VERDICT_FD, `${code}\n`);
      }
      process.exit(code);
    })
    .catch((e: unknown) => {
      // Fails closed: a guard that can't decide blocks the call (exit 2), with a reason Claude can show.
      process.stderr.write(`[${BRAND.cli}] hook ${event} failed: ${(e as Error)?.message ?? String(e)}\n`);
      process.exit(2);
    });
}
