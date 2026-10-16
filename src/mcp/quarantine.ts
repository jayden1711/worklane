// Q3: a server's snapshot is taken in quarantine first, with no secrets and no network, as the broker's user inside its
// sandbox, with no agent connected. A server that can't list its tools that way gets a second snapshot, taken with its
// installed secrets and its approved network, which is a second approval.
import { rmSync } from 'node:fs';
import { connectUpstream } from './upstream.js';
import { launchServer, type LaunchOptions } from './launch.js';
import type { Snapshot } from './snapshot.js';

export interface SnapshotResult {
  snapshot: Snapshot | null;
  error: string | null;
  withSecrets: boolean;
  network: string[];
}

export async function takeSnapshot(o: LaunchOptions & { timeoutMs?: number }): Promise<SnapshotResult> {
  const withSecrets = Object.keys(o.secrets).length > 0;
  const child = launchServer(o);
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
  const deadline = setTimeout(() => child.kill('SIGKILL'), (o.timeoutMs ?? 30_000) + 5_000);
  try {
    const up = await connectUpstream(child, { clientName: 'snapshot', timeoutMs: o.timeoutMs ?? 30_000 });
    const snapshot = up.snapshot;
    up.stop();
    // What it shows the model is stored where everyone may read it, and served to agents: never one of its secrets.
    const text = JSON.stringify(snapshot);
    if (Object.values(o.secrets).some((v) => v.length >= 4 && text.includes(v))) return { snapshot: null, error: "the server's tool list contains one of its own secrets; refused", withSecrets, network: o.network };
    return { snapshot, error: null, withSecrets, network: o.network };
  } catch (e) {
    child.kill('SIGKILL');
    // The preview is readable by all: a secret the server printed never reaches it.
    let tail = stderr.trim().split('\n').slice(-3).join(' | ');
    for (const v of Object.values(o.secrets)) if (v.length >= 4) tail = tail.split(v).join('[redacted]');
    return { snapshot: null, error: `${(e as Error).message}${tail ? ` (stderr: ${tail})` : ''}`, withSecrets, network: o.network };
  } finally {
    clearTimeout(deadline);
    rmSync(o.scratchDir, { recursive: true, force: true });
  }
}
