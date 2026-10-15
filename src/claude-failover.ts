// Auto-failover between the agents' Claude account profiles on a usage limit (issue #464, part 2). Off by default; on
// for the machine or one instance, with an order of profiles, from the Machine page (profiles.json's "failover",
// written by root: src/claude-profiles.ts).
//
// Each coordinator tick, for its own instance (failoverStep):
//   - a usage-limit pause in force and no move made for it yet: ask for the next profile in the order after the active
//     one (skipping any tried for this pause, and any still limited from an earlier move), as `claude-account use
//     <next> <instance>` through the machine helper. That is the same step a person takes: one minimal real call as
//     the agent user on the next profile first, and nothing changes if it is refused. Then the next one is tried.
//   - the move done: an info incident names both accounts and the reset time. The pause then ends on its own, as for
//     any account switch (src/coordinator/base.ts resumeIfDue).
//   - with "move back" on, once the reset has passed and the instance is still on the profile it moved to: ask for the
//     original, the same way (proven by a real call first); refused, it stays and asks again after FAILOVER_RETRY_MS.
// It never moves on an auth failure: a refused login is held by #463 (red incident, runs paused on that profile), and
// failover acts only on a usage-limit pause. Each step is an account.failover event; nothing here holds a token.
import type { EventLog } from './events/log.js';
import type { StoredEvent } from './events/types.js';
import { CLAUDE_ACCOUNT_DIR } from './claude-account.js';
import { activeProfile, failoverFor, readProfiles } from './claude-profiles.js';
import { claudeProfile, type Exec } from './machine.js';
import { FAILOVER_INCIDENT, pauseOf, resetWords, type IncidentSink } from './usage-limit.js';

export { FAILOVER_INCIDENT };

/** A move asked for with no answer after this long is given up (the step's unit never ran, or never ended). */
export const FAILOVER_ANSWER_MS = 30 * 60_000;
/** A move back that was refused is asked again after this long. */
export const FAILOVER_RETRY_MS = 15 * 60_000;

export type FailoverStage = 'asked' | 'switched' | 'refused' | 'none' | 'back-asked' | 'back' | 'back-refused';

interface Step {
  stage: FailoverStage;
  from: string;
  to: string;
  reset_at: string | null;
  detail: string;
  ts: string;
}

const stepsOf = (events: readonly StoredEvent[]): Step[] => events.filter((e) => e.type === 'account.failover').map((e) => ({ ...(e.payload as Omit<Step, 'ts'>), ts: e.ts }));

export interface FailoverDeps {
  log: EventLog;
  instance: string;
  /** The claude-account dir (profiles.json, profile-ops.jsonl); the machine's when unset. */
  dir?: string;
  now?: () => number;
  /** How the helper is run (sudo -n); machine.ts's default when unset. */
  exec?: Exec;
  incidents?: IncidentSink;
}

/** One pass of the failover for this instance. Returns what it did, for the record and the tests. */
export function failoverStep(d: FailoverDeps): FailoverStage | null {
  const now = (d.now ?? Date.now)();
  const profiles = readProfiles(d.dir ?? CLAUDE_ACCOUNT_DIR);
  const events = d.log.read(0, ['usage.paused', 'usage.resumed', 'account.failover', 'account.switched']);
  const steps = stepsOf(events);
  const emit = (s: Omit<Step, 'ts'>) => {
    d.log.append('account.failover', { stage: s.stage, from: s.from, to: s.to, reset_at: s.reset_at, detail: s.detail.slice(0, 1000) }, d.instance, 'coordinator');
    return s.stage;
  };
  const ask = (stage: 'asked' | 'back-asked', from: string, to: string, resetAt: string | null): FailoverStage => {
    emit({ stage, from, to, reset_at: resetAt, detail: stage === 'asked' ? `usage limit on ${from}: moving to ${to}, after a real call on it` : `the limit on ${to} has reset: moving back from ${from}, after a real call on it` });
    const r = claudeProfile(['use', to, d.instance], d.exec);
    if (!r.ok) return emit({ stage: stage === 'asked' ? 'refused' : 'back-refused', from, to, reset_at: resetAt, detail: `couldn't start the switch: ${r.error}` });
    return stage;
  };

  // 1. A move asked for: wait for its answer (account.switched, recorded from the step's own lines).
  const last = steps.at(-1);
  if (last && (last.stage === 'asked' || last.stage === 'back-asked')) {
    const answer = events.find((e) => e.type === 'account.switched' && Date.parse(e.ts) >= Date.parse(last.ts) && (e.payload as { to: string }).to === last.to);
    const back = last.stage === 'back-asked';
    if (!answer) {
      if (now - Date.parse(last.ts) < FAILOVER_ANSWER_MS) return null;
      return emit({ ...last, stage: back ? 'back-refused' : 'refused', detail: `no answer from the switch to ${last.to} after ${FAILOVER_ANSWER_MS / 60_000} min` });
    }
    const p = answer.payload as { ok: boolean; detail: string };
    if (!p.ok) return emit({ ...last, stage: back ? 'back-refused' : 'refused', detail: p.detail });
    if (back) {
      d.incidents?.resolveIncident(FAILOVER_INCIDENT, d.instance);
      return emit({ ...last, stage: 'back', detail: `back on ${last.to}: the API answered a real call on it` });
    }
    const when = last.reset_at ? resetWords(last.reset_at, now) : 'its reset';
    d.incidents?.raiseIncident(FAILOVER_INCIDENT, d.instance, `Claude usage limit on account ${last.from}: this instance moved to account ${last.to} (the API answered a real call on it). ${last.from}'s limit resets ${when}`, 'Nothing to do. To choose the account yourself, use the Accounts table on the Machine page; failover settings are there too');
    return emit({ ...last, stage: 'switched', detail: `on ${last.to}; ${last.from}'s limit resets ${when}` });
  }

  const setting = failoverFor(d.instance, profiles);
  if (!setting) return null;
  const active = activeProfile(d.instance, profiles);
  const pause = pauseOf(d.log.read(0, ['usage.paused', 'usage.resumed']));

  // 2. A usage-limit pause: move to the next profile in the order.
  if (pause) {
    const since = Date.parse(pause.since);
    const mine = steps.filter((s) => Date.parse(s.ts) >= since);
    if (mine.some((s) => s.stage === 'switched' || s.stage === 'none')) return null;
    // Still limited: every profile a move left whose reset hasn't come, and every one tried for this pause.
    const limited = new Set([active, ...steps.filter((s) => s.stage === 'switched' && s.reset_at && Date.parse(s.reset_at) > now).map((s) => s.from), ...mine.filter((s) => s.stage === 'asked').map((s) => s.to)]);
    const at = setting.order.indexOf(active);
    const after = at < 0 ? setting.order : [...setting.order.slice(at + 1), ...setting.order.slice(0, at)];
    const next = after.find((n) => !limited.has(n));
    if (!next) return emit({ stage: 'none', from: active, to: active, reset_at: pause.resetAt, detail: `usage limit on ${active}, and no other account in the failover order (${setting.order.join(', ')}) is free: waiting for the reset` });
    return ask('asked', active, next, pause.resetAt);
  }

  // 3. Back: the moves since the last move back (one, or a chain when the next account hit its limit too), once the
  // first one's reset has passed and the instance is still where the last one put it: back to where the chain began.
  if (!setting.back) return null;
  const lastBack = steps.map((s) => s.stage).lastIndexOf('back');
  const chain = steps.slice(lastBack + 1).filter((s) => s.stage === 'switched');
  const first = chain[0];
  if (!first?.reset_at || Date.parse(first.reset_at) > now || active !== chain.at(-1)!.to || first.from === active) return null;
  const tail = steps.at(-1);
  if (tail?.stage === 'back-refused' && now - Date.parse(tail.ts) < FAILOVER_RETRY_MS) return null;
  return ask('back-asked', active, first.from, first.reset_at);
}
