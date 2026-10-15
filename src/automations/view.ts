// The dashboard's view of the automations (Extend -> Automations): the owners' and writers' only (a viewer gets 403
// and no tab). Each automation with what it does in plain words, its next time, today's runs and spend, its last
// runs, and the controls this person may use (no dead buttons: a writer gets Pause and Run now, an owner every one).
import type { Role } from '../dashboard-auth.js';
import type { EventPayload, StoredEvent } from '../events/types.js';
import { localDay } from '../local-day.js';
import { nextSlots, parseCron } from './cron.js';
import { runsOn, spentOn } from './engine.js';
import { type AutomationLimits } from './schema.js';
import { ACTIONS, describe, describeTrigger, digestOf, mayDo, type Loaded } from './store.js';

export function automationsView(o: { loaded: Loaded; limits: AutomationLimits; events: StoredEvent[]; role: Role; now: Date }) {
  const day = localDay(o.now);
  const of = <T extends 'automation.fired' | 'automation.done' | 'automation.output' | 'automation.refused' | 'automation.changed'>(type: T) =>
    o.events.filter((e) => e.type === type).map((e) => ({ ts: e.ts, ...(e.payload as EventPayload<T>) }));
  const fired = of('automation.fired');
  const done = of('automation.done');
  const outputs = of('automation.output');
  const refused = of('automation.refused');
  const changed = of('automation.changed');
  const actions = ACTIONS.filter((a) => mayDo(a, o.role));
  return {
    limits: o.limits,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    today: { runs: runsOn(o.events, day), spentUsd: Math.round(spentOn(o.events, day) * 100) / 100 },
    error: o.loaded.error,
    digest: digestOf(o.loaded.text),
    /** What this person may do: the page shows these buttons and no other. */
    actions,
    automations: o.loaded.file.automations.map((a) => {
      const cron = a.trigger.kind === 'schedule' ? parseCron(a.trigger.cron) : null;
      const runs = fired
        .filter((f) => f.id === a.id)
        .slice(-5)
        .reverse()
        .map((f) => {
          const d = done.find((x) => x.run === f.run);
          const out = outputs.filter((x) => x.run === f.run).map((x) => ({ kind: x.kind, number: x.number }));
          return { run: f.run, at: f.ts, trigger: f.trigger, depth: f.depth, outcome: d?.outcome ?? 'running', costUsd: d?.cost_usd ?? null, outputs: out };
        });
      const pausedBySystem = !a.enabled ? changed.filter((c) => c.id === a.id && c.action === 'pause').at(-1) : undefined;
      return {
        ...a,
        when: describeTrigger(a.trigger),
        summary: describe(a),
        next: a.enabled && cron?.ok ? (nextSlots(cron.cron, o.now, 1)[0]?.toISOString() ?? null) : null,
        today: { runs: runsOn(o.events, day, a.id), spentUsd: Math.round(spentOn(o.events, day, a.id) * 100) / 100 },
        runs,
        refused: refused.filter((r) => r.id === a.id).slice(-3).reverse().map((r) => ({ at: r.ts, trigger: r.trigger, why: r.why })),
        pausedBy: pausedBySystem ? { by: pausedBySystem.by, role: pausedBySystem.role, why: pausedBySystem.why ?? null, at: pausedBySystem.ts } : null,
      };
    }),
  };
}
