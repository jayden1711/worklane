// WHY: run as the instance's coordinator user, so a measure uses that instance's checkout, event log, state and
// sandbox host (the helper through the coordinator's own sudoers rule), as its coordinator's runs do. ./measure.ts.

// INVARIANT: the host is always the sandbox host (no flag picks another; only a test passes MeasureIo.host), and no
// checks dependency, token or App key is loaded here: a measure can't post a check.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { BRAND } from '../brand.js';
import { EventLog } from '../events/log.js';
import { loadInstance } from '../instance.js';
import { sandboxHost, type RunHost } from './host.js';
import { MeasureRefused, measureLine, planMeasure, runMeasure, type MeasureValue } from './measure.js';
import { defaultBranch } from './workspace.js';

export const MEASURE_USAGE = `usage: ${BRAND.cli} testrun measure --instance <name> --tier <tier>[,<tier>...] --set KEY=V1,V2,... [--sha <commit>] [--json]`;

export interface MeasureArgs {
  sha: string | null;
  tiers: string[];
  sets: string[];
  json: boolean;
}

/** The command's arguments, strictly: anything unknown, or a flag without its value, is a usage error (null). */
export function parseMeasureArgs(args: readonly string[]): MeasureArgs | null {
  const a: MeasureArgs = { sha: null, tiers: [], sets: [], json: false };
  for (let i = 0; i < args.length; i++) {
    const f = args[i]!;
    if (f === '--json') {
      a.json = true;
      continue;
    }
    const v = args[i + 1];
    if (v === undefined || !['--sha', '--tier', '--set'].includes(f)) return null;
    i++;
    if (f === '--sha') {
      if (a.sha !== null) return null;
      a.sha = v;
    } else if (f === '--tier') a.tiers.push(...v.split(','));
    else a.sets.push(v);
  }
  return a;
}

export interface MeasureIo {
  out?: (l: string) => void;
  err?: (l: string) => void;
  /** Tests only (the CLI passes none): a host that records its calls, to prove a refusal makes none. */
  host?: (instance: string) => RunHost;
}

export async function measureCommand(instance: string | undefined, sub: string | undefined, rest: readonly string[], io: MeasureIo = {}): Promise<number> {
  const out = io.out ?? ((l: string) => console.log(l));
  const err = io.err ?? ((l: string) => console.error(l));
  const args = sub === 'measure' ? parseMeasureArgs(rest) : null;
  if (!args || !instance) {
    err(MEASURE_USAGE);
    return 2;
  }
  const i = loadInstance(instance);
  const config = i.config.tests.test_run;
  if (!config) {
    err(`refused: ${i.name} has no tests.yaml test_run; nothing was started`);
    return 2;
  }
  let plan;
  try {
    const given = args.sha ?? defaultBranch(i.repo.path)?.sha ?? '';
    plan = planMeasure(config, { sha: given, tiers: args.tiers, sets: args.sets });
    try {
      plan.sha = execFileSync('git', ['-C', i.repo.path, 'rev-parse', '--verify', '-q', `${plan.sha}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      throw new MeasureRefused(`${plan.sha} is not a commit in ${i.repo.path}; nothing was started`);
    }
  } catch (e) {
    if (!(e instanceof MeasureRefused)) throw e;
    err(`refused: ${e.message}`);
    return 2;
  }
  const log = new EventLog(join(i.stateDir, 'events.db'));
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    if (!args.json) out(`measuring ${plan.key} = ${plan.values.join(', ')} on ${plan.tiers.join(', ')} at ${plan.sha.slice(0, 12)}, one sandboxed run per value, in sequence`);
    const r = await runMeasure(
      {
        instance: i.name,
        config,
        host: (io.host ?? sandboxHost)(i.name),
        repo: i.repo.path,
        log,
        actor: `${BRAND.cli}-${i.name}-measure`,
        logDir: join(i.stateDir, 'test-runs-measure'),
        sparseExclude: i.config.tests.checkout.sparse_exclude,
        signal: stop.signal,
        onValue: (v: MeasureValue) => out(args.json ? JSON.stringify(v) : measureLine(v)),
      },
      plan,
    );
    if (r.stopped) err(`stopped: ${r.stopped}`);
    return r.stopped ? 1 : 0;
  } catch (e) {
    if (!(e instanceof MeasureRefused)) throw e;
    err(`refused: ${e.message}`);
    return 2;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    log.close();
  }
}
