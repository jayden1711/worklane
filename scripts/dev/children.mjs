// The processes a dev script starts (dashboards, demo servers), stopped however the
// script ends: run to the end, thrown, or interrupted. Without this, a script that
// throws halfway leaves its dashboard running on a temporary demo for hours.
// macOS, Linux and Windows (SIGINT, SIGTERM and SIGHUP are the ones Node can listen for there too).

/** Track children and clean-up steps for this process; they run once, on exit. */
export function exitCleanup() {
  const procs = new Set();
  const after = [];
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill();
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
    /** Stop this child when the script ends; returns it. */
    track(p) {
      procs.add(p);
      return p;
    },
    /** Run this when the script ends, after its children are stopped. */
    finally(f) {
      after.push(f);
    },
  };
}
