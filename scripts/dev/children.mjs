// The processes a dev script starts (dashboards, demo servers), stopped however the
// script ends: run to the end, thrown, or interrupted. Without this, a script that
// throws halfway leaves its dashboard running on a temporary demo for hours.
// macOS, Linux and Windows (SIGINT, SIGTERM and SIGHUP are the ones Node can listen for there too).

/**
 * Whether this is a started child: a positive pid. Never anything else, whatever it says: a pid of 0 (or below) names
 * a process group, and process.kill(0, ...) signals every process in this one, the test runner and the shell included.
 */
const isChild = (p) => Number.isInteger(p.pid) && p.pid > 0;

/** Track children and clean-up steps for this process; they run once, on exit. */
export function exitCleanup() {
  const procs = new Set();
  const after = [];
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    for (const p of procs) if (isChild(p) && p.exitCode === null && p.signalCode === null) p.kill();
    for (const f of after) {
      try {
        f();
      } catch {
        // best effort: a temporary directory left behind is harmless
      }
    }
  };
  process.on('exit', stop);
  // A signal skips 'exit' unless it is handled: exit with the shell's code for it, which runs stop.
  for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.on(sig, () => process.exit(code));
  return {
    /**
     * Stop this child when the script ends; returns it. One that didn't start has no pid: it is never tracked, and its
     * spawn error ends the script, named (unless the script handles the child's errors itself).
     */
    track(p) {
      p.on('error', (e) => {
        procs.delete(p);
        if (p.listenerCount('error') > 1) return;
        throw isChild(p) ? e : new Error(`a child didn't start (${p.spawnfile ?? 'unknown'}): ${e.message}`, { cause: e });
      });
      if (isChild(p)) procs.add(p);
      return p;
    },
    /** Run this when the script ends, after its children are stopped. */
    finally(f) {
      after.push(f);
    },
  };
}
