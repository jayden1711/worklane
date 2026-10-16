/** How long after each failed check the next one runs: the first three, then SANDBOX_RETRY_MAX_MS every time. */
export const SANDBOX_RETRY_MS = [30_000, 60_000, 120_000];
export const SANDBOX_RETRY_MAX_MS = 300_000;
export const sandboxRetryMs = (failures) => SANDBOX_RETRY_MS[failures - 1] ?? SANDBOX_RETRY_MAX_MS;
const every = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
const indent = (detail) => detail.split('\n').map((l) => `  ${l}`).join('\n');
export class SandboxWatch {
    d;
    state = { ok: false, detail: 'the sandbox check has not run yet' };
    failures = 0;
    failingSince = null;
    inFlight = null;
    next = null;
    recorded = null;
    stopped = false;
    constructor(d) {
        this.d = d;
    }
    get ok() {
        return this.state.ok;
    }
    get detail() {
        return this.state.detail;
    }
    /** Checks failed in a row since the last pass. */
    get failed() {
        return this.failures;
    }
    /**
     * Run the check once; while it fails, the next one is scheduled from here. INVARIANT: never two at once: a call
     * while one runs gets that one's result (the check makes a probe run in the sandbox, and wipes it).
     */
    check() {
        this.inFlight ??= this.once().finally(() => {
            this.inFlight = null;
        });
        return this.inFlight;
    }
    async once() {
        this.next?.cancel();
        this.next = null;
        const now = this.d.now ?? Date.now;
        const say = this.d.say ?? ((line) => console.error(line));
        const r = await this.d.check().catch((e) => ({ ok: false, detail: `the check didn't run: ${e.message}` }));
        const detail = r.detail.slice(0, 2000);
        // WHY: one event per change, not one per check: the watchdog and the dashboard read the newest, and a sandbox
        // that stays broken for a day would otherwise write 288 identical events.
        const key = `${r.ok} ${detail}`;
        if (key !== this.recorded) {
            this.d.log.append('testrun.sandbox', { ok: r.ok, detail }, this.d.actor);
            this.recorded = key;
        }
        if (r.ok) {
            const was = this.failures;
            const since = this.failingSince;
            this.failures = 0;
            this.failingSince = null;
            this.state = { ok: true, detail };
            if (was)
                say(`test runs are on again: the test sandbox check passed, after ${was} failed check${was === 1 ? '' : 's'} over ${every(Math.max(0, now() - (since ?? now())))}; no restart needed`);
            if (!this.stopped) {
                try {
                    await this.d.passed?.();
                }
                catch (e) {
                    say(`test runs: after the sandbox check passed: ${e.message.slice(0, 500)}`);
                }
            }
            return true;
        }
        this.failures += 1;
        this.failingSince ??= now();
        const changed = detail !== this.state.detail;
        this.state = { ok: false, detail };
        const wait = sandboxRetryMs(this.failures);
        const head = `test runs are OFF: the test sandbox check failed (${this.failures} in a row); no test run starts until it passes. Checked again in ${every(wait)}; test runs go on by themselves when it passes.`;
        // WHY: the FAIL lines the first time and whenever they change; the same lines again every 5 minutes say nothing new.
        say(changed || this.failures === 1 ? `${head}\n${indent(detail)}` : `${head} The same failure as before.`);
        if (!this.stopped)
            this.next = (this.d.timer ?? defaultTimer)(() => void this.check(), wait);
        return false;
    }
    /** The coordinator is stopping: no further check is scheduled, and one in flight changes nothing more. */
    stop() {
        this.stopped = true;
        this.next?.cancel();
        this.next = null;
    }
}
function defaultTimer(fn, ms) {
    const t = setTimeout(fn, ms);
    // WHY: a pending re-check must not hold a stopping coordinator open (the run loop holds it while it runs).
    t.unref();
    return { cancel: () => clearTimeout(t) };
}
//# sourceMappingURL=sandbox-watch.js.map