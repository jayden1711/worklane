// Answering onboarding's asks in the terminal that runs `add`: each open ask in turn, as the owner.
// A root step runs only through the machine helper; here sudo may ask for your password (it reads it from
// the terminal), where the dashboard needs the passwordless setup-user rule.
import { spawnSync } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import { Writable } from 'node:stream';
import type { Ask } from '../console/asks.js';
import { MACHINE_HELPER, type Exec } from '../machine.js';
import { answerSecret, runRootStep } from './answer.js';
import type { Onboarding } from './flow.js';

/** sudo that may prompt for a password on the terminal (no -n); stdout is captured for the step, then shown. */
export const terminalSudo: Exec = (file, args, input) => {
  const a = file === 'sudo' && args[0] === '-n' ? args.slice(1) : args;
  const r = spawnSync(file, a, { encoding: 'utf8', stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'inherit'], ...(input === undefined ? {} : { input }) });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.error || r.status !== 0) throw Object.assign(new Error(r.error?.message ?? `exit ${r.status}`), { stdout: r.stdout ?? '', stderr: r.error?.message ?? `exited ${r.status}` });
  return r.stdout ?? '';
};

export function quoteArgs(args: string[]): string {
  return args.map((a) => (/^[A-Za-z0-9_./:=@-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

/** What an ask shows: its title, detail and what answering means. */
export function describeAsk(a: Ask): string {
  const head = `\n== ${a.title}\n${a.detail}\n`;
  if (a.kind === 'approve_link') return `${head}\n  open: ${a.url}\n`;
  if (a.kind === 'root_step') return `${head}\n  runs: sudo ${MACHINE_HELPER} ${quoteArgs([a.command, ...a.args])}\n`;
  if (a.kind === 'question') return `${head}\n  answers: ${a.options.join(' | ')}\n`;
  return `${head}\n  (paste ${a.credential}; it is not shown, and goes ${a.where})\n`;
}

function prompt(rl: Interface, text: string, stillOpen: () => boolean): Promise<string | null> {
  const ac = new AbortController();
  const t = setInterval(() => !stillOpen() && ac.abort(), 500);
  return new Promise<string | null>((resolve) => {
    rl.question(text, { signal: ac.signal }, (v) => resolve(v));
    ac.signal.addEventListener('abort', () => resolve(null), { once: true });
  }).finally(() => clearInterval(t));
}

/** Answer the run's open asks as they come, until `signal` aborts. */
export async function answerInTerminal(onb: Onboarding, signal: AbortSignal, o: { exec?: Exec; input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}): Promise<void> {
  let muted = false;
  const out = o.output ?? process.stdout;
  const sink = new Writable({ write: (chunk, _e, cb) => (muted ? cb() : out.write(chunk, cb)) });
  const rl = createInterface({ input: o.input ?? process.stdin, output: sink, terminal: Boolean((o.input ?? process.stdin) === process.stdin && process.stdin.isTTY) });
  const seen = new Set<string>();
  try {
    while (!signal.aborted) {
      const open = onb.asks.list({ status: 'open' }).filter((a) => !seen.has(a.id));
      const a = open[0];
      if (!a) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      const isOpen = () => !signal.aborted && onb.asks.get(a.id)?.status === 'open';
      out.write(describeAsk(a));
      try {
        if (a.kind === 'question') {
          for (;;) {
            const v = await prompt(rl, `answer (${a.options.join('/')}): `, isOpen);
            if (v === null) break;
            if (a.options.includes(v.trim())) {
              onb.asks.answer(a.id, { by: onb.by, role: 'owner', answer: v.trim() });
              break;
            }
          }
        } else if (a.kind === 'approve_link') {
          const v = await prompt(rl, 'Enter when done (or type declined): ', isOpen);
          if (v !== null && isOpen()) onb.asks.answer(a.id, { by: onb.by, role: 'owner', answer: v.trim() === 'declined' ? 'declined' : 'approved' });
        } else if (a.kind === 'paste_secret') {
          for (;;) {
            out.write('paste, then Enter: ');
            muted = true;
            const v = await prompt(rl, '', isOpen);
            muted = false;
            out.write('\n');
            if (v === null) break;
            try {
              answerSecret(onb.log, onb.dir, a.id, onb.by, v);
              break;
            } catch (e) {
              out.write(`${(e as Error).message}\n`);
            }
          }
        } else if (a.kind === 'root_step') {
          if (!a.allowed) {
            out.write(`refused: ${a.refusal}\n`);
            onb.asks.answer(a.id, { by: onb.by, role: 'owner', answer: 'declined' });
          } else {
            const v = await prompt(rl, 'Run it now? [Y/n] ', isOpen);
            if (v !== null && isOpen()) {
              if (/^n/i.test(v.trim())) onb.asks.answer(a.id, { by: onb.by, role: 'owner', answer: 'declined' });
              else {
                const done = runRootStep(onb.log, onb.dir, a.id, onb.by, o.exec ?? terminalSudo);
                out.write(`${done.answer?.answer === 'ran' ? 'ran' : `FAILED: ${done.answer?.detail ?? ''}`}\n`);
              }
            }
          }
        }
      } catch (e) {
        out.write(`${(e as Error).message}\n`);
      }
      seen.add(a.id);
    }
  } finally {
    rl.close();
  }
}
