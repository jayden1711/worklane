// The dashboard's Add project: the same onboarding as `add`, started from the page, which shows its steps and
// answers its asks. Only on a dashboard the owner runs as their own login (never an instance's, whose server runs
// as its coordinator, nor the hub): onboarding holds a new App's key until it hands it to the new coordinator.
//
//   GET  /api/onboard            every onboarding on this login: its steps and its asks (never a secret)
//   POST /api/onboard            { repo, name? }: start one (or continue it), in this server
//   POST /api/onboard/answer     { repo, id, answer }: an approve link (approved|declined) or a question
//   POST /api/onboard/secret     { repo, id, value }: a pasted secret, staged owner-only, never echoed
//   POST /api/onboard/run        { repo, id }: a root step, through the machine helper (sudo -n)
import { existsSync, readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { AskError, asks as asksOf, asksFrom, ASK_EVENTS, type Ask } from '../console/asks.js';
import { EventLog } from '../events/log.js';
import type { EventPayload } from '../events/types.js';
import type { Exec } from '../machine.js';
import { answerSecret, runRootStep } from './answer.js';
import { onboardingDir, onboardingLog, onboardingRoot, Onboarding, STEP_ORDER, STEP_TITLES, type OnboardDeps } from './flow.js';
import type { FixedCheck } from './doctor.js';

export interface OnboardView {
  repo: string;
  instance: string;
  running: boolean;
  result: { ok: boolean; error?: string; report: FixedCheck[] } | null;
  steps: { id: string; title: string; status: 'done' | 'skipped' | 'failed' | 'pending'; detail: string }[];
  asks: Ask[];
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** One onboarding's view, from its log. */
export function viewOf(dir: string, live?: { running: boolean; result: OnboardView['result'] }): OnboardView | null {
  const file = onboardingLog(dir);
  if (!existsSync(file)) return null;
  const log = new EventLog(file);
  try {
    const steps = log.read(0, ['onboard.step']).map((e) => e.payload as EventPayload<'onboard.step'>);
    const asks = asksFrom(log.read(0, [...ASK_EVENTS]));
    const last = new Map(steps.map((s) => [s.step, s]));
    const first = steps[0] ?? (asks[0] ? { repo: '', instance: asks[0].instance } : null);
    if (!first) return null;
    return {
      repo: first.repo || dir.split(/[\\/]/).pop()!.replace('--', '/'),
      instance: first.instance,
      running: live?.running ?? false,
      result: live?.result ?? null,
      steps: STEP_ORDER.map((id) => {
        const s = last.get(id);
        return { id, title: STEP_TITLES[id], status: s?.status ?? 'pending', detail: s?.detail ?? '' };
      }),
      asks: [...asks.filter((a) => a.status === 'open'), ...asks.filter((a) => a.status !== 'open').reverse().slice(0, 30)],
    };
  } finally {
    log.close();
  }
}

export interface OnboardServiceOptions {
  /** Who answers: the owner's GitHub login. */
  by: string;
  deps: () => OnboardDeps;
  root?: string;
  /** How root steps run (sudo -n through the helper by default). */
  exec?: Exec;
  pollMs?: number;
}

export function onboardService(o: OnboardServiceOptions) {
  const root = o.root ?? onboardingRoot();
  const live = new Map<string, { onb: Onboarding; running: boolean; result: OnboardView['result'] }>();
  const dirOf = (repo: unknown) => {
    if (typeof repo !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(repo) || repo.includes('..')) throw new AskError('repo must be owner/repo');
    return onboardingDir(repo, root);
  };
  const list = (): OnboardView[] => {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const dir = join(root, e.name);
        const l = [...live.values()].find((x) => x.onb.dir === dir);
        return viewOf(dir, l ? { running: l.running, result: l.result } : undefined);
      })
      .filter((v): v is OnboardView => v !== null);
  };
  const start = (repo: string, name?: string) => {
    const dir = dirOf(repo);
    const cur = live.get(dir);
    if (cur?.running) return cur.onb;
    cur?.onb.close();
    const onb = new Onboarding({ repo, ...(name ? { name } : {}), by: o.by, dir, ...(o.pollMs ? { pollMs: o.pollMs } : {}) }, o.deps());
    const entry = { onb, running: true, result: null as OnboardView['result'] };
    live.set(dir, entry);
    void onb.run().then(
      (r) => ((entry.running = false), (entry.result = r)),
      (e: Error) => ((entry.running = false), (entry.result = { ok: false, error: e.message, report: [] })),
    );
    return onb;
  };
  /** The log to answer an ask in: the live run's, else the folder's own (a run started from the terminal). */
  const withLog = <T>(repo: unknown, f: (log: EventLog, dir: string) => T): T => {
    const dir = dirOf(repo);
    const l = live.get(dir);
    if (l) return f(l.onb.log, dir);
    if (!existsSync(onboardingLog(dir))) throw new AskError(`no onboarding of ${String(repo)}`, 404);
    const log = new EventLog(onboardingLog(dir));
    try {
      return f(log, dir);
    } finally {
      log.close();
    }
  };

  return {
    list,
    start,
    close: () => {
      for (const l of live.values()) l.onb.close();
    },
    /** Handle an /api/onboard request; false when the path isn't one of these. */
    async handle(req: IncomingMessage, res: ServerResponse, url: URL, body: () => Promise<unknown>): Promise<boolean> {
      if (!url.pathname.startsWith('/api/onboard')) return false;
      try {
        if (url.pathname === '/api/onboard' && req.method === 'GET') return json(res, 200, { available: true, by: o.by, runs: list() }), true;
        const b = (await body()) as { repo?: unknown; name?: unknown; id?: unknown; answer?: unknown; value?: unknown };
        if (req.method !== 'POST') return json(res, 405, { error: 'POST' }), true;
        if (url.pathname === '/api/onboard') {
          if (b.name !== undefined && (typeof b.name !== 'string' || !/^[a-z][a-z0-9-]{0,20}$/.test(b.name))) throw new AskError('name: lowercase letters, digits and dashes');
          const onb = start(String(b.repo ?? ''), b.name as string | undefined);
          return json(res, 202, { ok: true, repo: onb.repo, instance: onb.name }), true;
        }
        const id = String(b.id ?? '');
        if (url.pathname === '/api/onboard/answer') return json(res, 200, withLog(b.repo, (log) => asksOf(log).answer(id, { by: o.by, role: 'owner', answer: String(b.answer ?? '') }))), true;
        if (url.pathname === '/api/onboard/secret') {
          if (typeof b.value !== 'string' || !b.value) throw new AskError('value is required');
          const a = withLog(b.repo, (log, dir) => answerSecret(log, dir, id, o.by, b.value as string));
          return json(res, 200, { id: a.id, status: a.status }), true;
        }
        if (url.pathname === '/api/onboard/run') return json(res, 200, withLog(b.repo, (log, dir) => runRootStep(log, dir, id, o.by, o.exec))), true;
        return json(res, 404, { error: 'not found' }), true;
      } catch (e) {
        if (e instanceof AskError) return json(res, e.status, { error: e.message }), true;
        throw e;
      }
    },
  };
}
export type OnboardService = ReturnType<typeof onboardService>;
