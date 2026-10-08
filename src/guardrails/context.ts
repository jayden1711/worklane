// Runtime inputs for guardrail evaluation: stored fingerprint sets and CLI
// link resolvers. Fingerprints are stored machine-locally, hashes only.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BRAND } from '../brand.js';
import type { GuardrailsConfig } from '../config/schema.js';
import { homeDir, stateDir } from '../os/index.js';
import { railwayLinkedEnvironment } from '../adapters/railway.js';
import type { EvalContext } from './engine.js';
import { findConnections, fingerprint } from './fingerprint.js';

interface StoredSets {
  sets: Record<string, { hashes: string[]; fetchedAt: string }>;
}

/** Per-project state folder, keyed by the project's absolute path. */
export function projectStateDir(projectRoot: string): string {
  const key = createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 16);
  return join(stateDir(), 'projects', key);
}

const setsFile = (projectRoot: string) => join(projectStateDir(projectRoot), 'fingerprints.json');

export function loadFingerprintSets(projectRoot: string): Record<string, Set<string>> {
  try {
    const data = JSON.parse(readFileSync(setsFile(projectRoot), 'utf8')) as StoredSets;
    return Object.fromEntries(Object.entries(data.sets).map(([k, v]) => [k, new Set(v.hashes)]));
  } catch {
    return {};
  }
}

export interface RefreshResult {
  name: string;
  ok: boolean;
  count: number;
  error?: string;
}

/**
 * Run each set's read-only command, hash the value at `key`, and store only
 * the hashes. The secret itself is never written or printed.
 */
export function refreshFingerprints(projectRoot: string, cfg: GuardrailsConfig): RefreshResult[] {
  const results: RefreshResult[] = [];
  const stored: StoredSets = { sets: {} };
  try {
    Object.assign(stored, JSON.parse(readFileSync(setsFile(projectRoot), 'utf8')));
  } catch {
    // first refresh
  }
  for (const [name, spec] of Object.entries(cfg.fingerprints)) {
    try {
      const out = execSync(spec.command, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
      const value = (JSON.parse(out) as Record<string, unknown>)[spec.key];
      const hashes = typeof value === 'string' ? findConnections(value).map((c) => fingerprint(c)).filter((h): h is string => !!h) : [];
      if (!hashes.length) throw new Error(`no connection string at key ${spec.key}`);
      stored.sets[name] = { hashes, fetchedAt: new Date().toISOString() };
      results.push({ name, ok: true, count: hashes.length });
    } catch (e) {
      results.push({ name, ok: false, count: 0, error: (e as Error).message.split('\n')[0]! });
    }
  }
  mkdirSync(projectStateDir(projectRoot), { recursive: true });
  writeFileSync(setsFile(projectRoot), JSON.stringify(stored, null, 2), { mode: 0o600 });
  return results;
}

export function liveContext(projectRoot: string, env: NodeJS.ProcessEnv = process.env): EvalContext {
  const sets = loadFingerprintSets(projectRoot);
  return {
    projectRoot,
    agent: env[`${BRAND.envPrefix}_AGENT`] === '1',
    env,
    home: homeDir(),
    fingerprints: sets,
    linkedEnvironment(resolver, cwd) {
      return resolver === 'railway' ? railwayLinkedEnvironment(cwd) : null;
    },
  };
}
