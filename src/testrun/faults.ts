// Machine faults a test-run step can meet, told apart from an ordinary failing test (docs/testing-in-production.md,
// item d: the failures of the weekend of 2026-11-07). Pure: text in, a fault out. The run (./run.ts) reports each on the
// tier's check and as a testrun.fault event, and never runs the step again by itself:
//   - gpu_lost: the GPU fell off the bus (PCIe fatal error, Xid 79) and the driver finds no device. The run is a
//     stopped GPU run (./gpu.ts gpuStopped): never repeated, and its later GPU tiers aren't run.
//   - host_key_changed: an SSH host's key isn't the one known (its IP changed, or it was reinstalled). A person checks
//     the new key; nothing here ever accepts one (no StrictHostKeyChecking=no or accept-new anywhere in src/).
//   - host_unreachable: an SSH host didn't answer (a reboot that hung, a host down until a power cycle).
//   - disk_full: a write failed for want of space.
//   - self_matching_wait: the step waits in a loop on `pgrep -f X` or `ps … | grep X`. The step runs under `sh -c
//     "<command>"`, whose own command line holds X, so the wait matches its own shell and never ends. Refused before
//     it runs.
// Output is classified only for a step that failed: a passing test may print any of these words.

export type Fault = 'gpu_lost' | 'host_key_changed' | 'host_unreachable' | 'disk_full' | 'self_matching_wait';

const OUTPUT_FAULTS: readonly { fault: Exclude<Fault, 'self_matching_wait'>; re: RegExp }[] = [
  { fault: 'gpu_lost', re: /No devices were found|\bXid\b[^\n]{0,80}?\b79\b|GPU has fallen off the bus|Unable to determine the device handle for GPU|NVML: (?:GPU is lost|Unknown Error)/i },
  { fault: 'host_key_changed', re: /REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed|Host key for \S+ has changed/i },
  { fault: 'host_unreachable', re: /ssh: connect to host \S+ port \d+: (?:Connection timed out|No route to host|Network is unreachable|Host is down)|Connection timed out during banner exchange/i },
  { fault: 'disk_full', re: /No space left on device|\bENOSPC\b|Disk quota exceeded|\bEDQUOT\b/ },
];

/** What a tier's check says for each fault: what happened, and that it isn't run again by itself. */
export const FAULT_LINE: Record<Fault, string> = {
  gpu_lost: 'the GPU was lost during the run (no device found: a PCIe fault, Xid 79): not rerun automatically, and its later GPU tiers were not run; check the machine, then push again',
  host_key_changed: "an SSH host's key changed (or isn't known): not retried, and no new key is accepted; a person checks the new key and updates known_hosts",
  host_unreachable: 'an SSH host did not answer (down, or a reboot that hung): not retried; check the host, then push again',
  disk_full: 'the disk filled during the run: not retried; free space, then push again',
  self_matching_wait: 'not run: it waits on `pgrep -f` or `ps … | grep` in a loop, which matches its own shell and never ends; wait on a pidfile, a lock, or `pgrep -x <exact name>`',
};

/** The first fault a failed step's output shows, with the line that shows it (clipped), or null. */
export function outputFault(out: string): { fault: Exclude<Fault, 'self_matching_wait'>; evidence: string } | null {
  for (const { fault, re } of OUTPUT_FAULTS) {
    const m = re.exec(out);
    if (!m) continue;
    const start = out.lastIndexOf('\n', m.index) + 1;
    const end = out.indexOf('\n', m.index);
    return { fault, evidence: out.slice(start, end < 0 ? undefined : end).trim().slice(0, 200) };
  }
  return null;
}

/** A loop (until/while) whose condition or body waits on `pgrep -f…` or on `ps … | grep`: the text that shows it, or null. */
export function selfMatchingWait(command: string): string | null {
  const wait = /\bpgrep\s+(?:-[A-Za-z]*f[A-Za-z]*|--full)(?=\s)[^;\n|&]*|\bps\b[^|;\n]*\|\s*grep\b[^;\n|&]*/;
  // Each loop, to its `done` (or the end, for one cut off), across lines.
  for (const m of command.matchAll(/\b(?:until|while)\b([\s\S]*?)(?:\bdone\b|$)/g)) {
    const w = wait.exec(m[1]!);
    if (w) return w[0].trim().slice(0, 200);
  }
  return null;
}
