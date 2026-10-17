import { localDay } from '../local-day.js';
import { nextSlots, parseCron } from './cron.js';
import { runsOn, spentOn } from './engine.js';
import { readHooksState, readSecret } from './secrets.js';
import { ACTIONS, describe, describeTrigger, digestOf, mayDo } from './store.js';
export function automationsView(o) {
    const hookState = o.hooks ? readHooksState(o.hooks.stateDir) : null;
    const resolved = new Set(o.events.filter((e) => e.type === 'automation.resolved').map((e) => e.payload.decision));
    const day = localDay(o.now);
    const of = (type) => o.events.filter((e) => e.type === type).map((e) => ({ ts: e.ts, ...e.payload }));
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
                /** A webhook's address (on this machine's tailnet name, port 8444), its bound device, and whether it has a secret. */
                webhook: a.trigger.kind === 'webhook' && o.hooks
                    ? { path: `/hook/${o.hooks.instance}/${a.id}`, bound: hookState?.bound[a.id] ? { name: hookState.bound[a.id].name, at: hookState.bound[a.id].at } : null, hasSecret: readSecret(o.hooks.home, a.id) !== null }
                    : null,
                /** Fires waiting for its owner's approval now. */
                waiting: o.events.filter((e) => e.type === 'automation.pending' && e.payload.id === a.id && !resolved.has(e.payload.decision)).map((e) => e.payload.decision),
                pausedBy: pausedBySystem ? { by: pausedBySystem.by, role: pausedBySystem.role, why: pausedBySystem.why ?? null, at: pausedBySystem.ts } : null,
            };
        }),
    };
}
//# sourceMappingURL=view.js.map