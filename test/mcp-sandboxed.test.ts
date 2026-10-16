// The MCP broker's sandbox (src/mcp/sandboxed.ts) never turns on sandbox-runtime's TLS interception. The library's
// MITM CA is built with node-forge (dist/sandbox/mitm-ca.js, mitm-leaf.js), which carries GHSA-86w9-cpqp-85rv with no
// patched release; that code runs only when the config asks for it (network.tlsTerminate builds the CA,
// network.mitmProxy routes hosts to an intercepting proxy). These tests pin the config the broker hands the library,
// that runSandboxed hands it exactly that, and the library's own list of such options, so a new or renamed one in a
// later version fails here instead of going unnoticed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SandboxRuntimeConfigSchema } from '@anthropic-ai/sandbox-runtime';
import { runSandboxed, sandboxRuntimeConfig, type SandboxedConfig, type SandboxManagerLike } from '../src/mcp/sandboxed.js';

const cfg: SandboxedConfig = {
  allowedDomains: ['api.example.com'],
  denyRead: ['/home/example/secrets'],
  allowWrite: ['/tmp/example-scratch'],
  cwd: '/tmp/example-scratch',
};

/** A key that names interception: a MITM proxy, TLS termination, a CA or any proxy setting. */
const INTERCEPTION = /mitm|proxy|tls|^ca$|ca(cert|key)/i;

/** Every key path in a plain value, depth first. */
function keyPaths(v: unknown, at = ''): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => keyPaths(x, `${at}[${i}]`));
  if (v && typeof v === 'object')
    return Object.entries(v).flatMap(([k, x]) => [`${at}${at ? '.' : ''}${k}`, ...keyPaths(x, `${at}${at ? '.' : ''}${k}`)]);
  return [];
}

/** Every option path a zod (v3) schema accepts, through optional/effects/default wrappers. */
function schemaPaths(schema: unknown, at = ''): string[] {
  let s = schema as { _def?: Record<string, unknown>; shape?: Record<string, unknown> };
  for (let i = 0; i < 20 && s?._def; i++) {
    const d = s._def;
    const inner = d.innerType ?? d.schema ?? (d.typeName === 'ZodArray' ? d.type : undefined);
    if (!inner) break;
    s = inner as typeof s;
  }
  if (!s?._def || s._def.typeName !== 'ZodObject') return [];
  const shape = (typeof s._def.shape === 'function' ? (s._def.shape as () => Record<string, unknown>)() : s.shape) ?? {};
  return Object.entries(shape).flatMap(([k, x]) => {
    const p = `${at}${at ? '.' : ''}${k}`;
    return [p, ...schemaPaths(x, p)];
  });
}

test("the broker never turns on sandbox-runtime's MITM proxy (node-forge GHSA-86w9-cpqp-85rv path)", () => {
  const out = sandboxRuntimeConfig(cfg);
  assert.deepEqual(Object.keys(out).sort(), ['filesystem', 'network']);
  assert.deepEqual(Object.keys(out.network).sort(), ['allowedDomains', 'deniedDomains']);
  assert.deepEqual(Object.keys(out.filesystem).sort(), ['allowWrite', 'denyRead', 'denyWrite']);
  const intercepting = keyPaths(out).filter((p) => INTERCEPTION.test(p.split('.').at(-1)!.replace(/\[\d+\]$/, '')));
  assert.deepEqual(intercepting, [], `interception keys in the sandbox config: ${intercepting.join(', ')}`);
  assert.deepEqual(out, {
    network: { allowedDomains: cfg.allowedDomains, deniedDomains: [] },
    filesystem: { denyRead: cfg.denyRead, allowWrite: cfg.allowWrite, denyWrite: [] },
  });
});

test("none of sandbox-runtime's own interception options (read from its installed schema) is in the broker's config", () => {
  const all = schemaPaths(SandboxRuntimeConfigSchema);
  assert.ok(all.includes('network.allowedDomains') && all.includes('filesystem.denyRead'), `schema walk found: ${all.join(', ')}`);
  const options = all.filter((p) => INTERCEPTION.test(p.split('.').at(-1)!));
  // The installed 0.0.78's list. A version that adds or renames one fails here: check it against the broker's config
  // (and the node-forge advisory) before updating this list.
  assert.deepEqual(options.sort(), [
    'network.httpProxyPort',
    'network.mitmProxy',
    'network.parentProxy',
    'network.parentProxy.noProxy',
    'network.socksProxyPort',
    'network.tlsTerminate',
    'network.tlsTerminate.caCertPath',
    'network.tlsTerminate.caKeyPath',
    'network.tlsTerminate.extraCaCertPaths',
    'windows.proxyPortRange',
  ]);
  const used = new Set(keyPaths(sandboxRuntimeConfig(cfg)));
  assert.deepEqual(options.filter((p) => used.has(p)), []);
  // And what the broker passes is valid for the library as is, so nothing is filled in around it.
  assert.equal(SandboxRuntimeConfigSchema.safeParse(sandboxRuntimeConfig(cfg)).success, true);
});

test('runSandboxed hands sandbox-runtime exactly sandboxRuntimeConfig(cfg), nothing added', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-sandboxed-'));
  const file = join(dir, 'config.json');
  writeFileSync(file, JSON.stringify(cfg));
  const seen: unknown[] = [];
  const stop = new Error('stop before spawning');
  const manager: SandboxManagerLike = {
    initialize: async (...args: unknown[]) => {
      seen.push(...args);
      throw stop;
    },
    wrapWithSandbox: async () => assert.fail('initialize stops the run first'),
    reset: async () => {},
  } as unknown as SandboxManagerLike;
  await assert.rejects(runSandboxed(file, ['true'], manager), (e) => e === stop);
  assert.deepStrictEqual(seen, [sandboxRuntimeConfig(cfg)]);
});
