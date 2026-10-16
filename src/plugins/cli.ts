// `<cli> plugins ...`: the root side of plugin approvals, as scripts/setup/plugins.sh and the machine helper call it.
//   plugins fetch-job --url <https> --sha <40 hex> [--path <dir>] --out <dir>     the throwaway user's fetch (no root)
//   plugins fetch-slot --instance <i>                                               root: take one of the hour's fetches
//   plugins ingest  --instance <i> --id <id> --url .. --sha .. [--path ..] --from <dir>   root: inspect, preview
//   plugins stage   --instance <i> --id <id> --roles <a+b> --digest sha256:<hex>   root (the helper's plugin-stage)
//   plugins withdraw --instance <i> --id <id>                                       root (the helper's plugin-withdraw)
//   plugins remove  --instance <i> --id <id>                                        root (the helper's plugin-remove)
//   plugins confirm --instance <i> --id <id> --digest sha256:<hex>                  root, an admin at a root shell only
//   plugins show    --instance <i>                                                  anyone: the allowlist, checked
// MCP servers (src/mcp/):
//   plugins npm-job --package <name> --version <x.y.z> --out <dir>                  the throwaway user's npm fetch (no root)
//   plugins mcp-ingest-npm --instance <i> --id <id> --from <dir>                    root: quarantine snapshot, preview
//   plugins mcp-preview --instance <i> --id <id> --plugin <id> --server <name>      root: an approved plugin's server
//   plugins mcp-snapshot --instance <i> --id <id>                                   root: the second snapshot, with secrets
//   plugins stage ... --network <h+h|none> --secrets <A+B|none>                     an MCP server's stage
import { createInterface } from 'node:readline';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from '../brand.js';
import { groupGid, isRoot, userHomeDir, userUid } from '../os/index.js';
import { mcpStatePath } from '../os/system-paths.js';
import { AllowlistError, HOST, parseRoles, readAllowlist, SECRET_NAME, type McpRecord, type McpRuntime } from './approval.js';
import { fetchGitPlugin, sourceProblem } from './fetch.js';
import { confirm, confirmPlan, describeRecord, ingest, mcpCodeDir, NPM_TREE_LIMITS, previewCodeDir, previewNpmServer, previewPluginServer, readPreview, remove, setPreviewSnapshot, stage, takeFetchSlot, withdraw } from './root-ops.js';
import { treeHash } from './tree.js';
import { fetchNpmServer, type NpmResult } from '../mcp/npm.js';
import { type SnapshotResult } from '../mcp/quarantine.js';
import { runThrowawaySnapshot, snapshotJob } from '../mcp/throwaway.js';
import { brokerSnapshot } from '../mcp/client.js';
import { curlResolve, pinnedAddress, pluginUrlProblem, readMcpRegistries, readPluginHosts } from './hosts.js';

const USAGE = 'usage: plugins fetch-job|fetch-slot|ingest|stage|withdraw|remove|confirm|show|npm-job|mcp-ingest-npm|mcp-preview|mcp-snapshot [options] (see src/plugins/cli.ts)';

/** A `+`-joined list from the helper (`none` for empty), each checked. */
function plusList(s: string | undefined, re: RegExp, what: string): string[] {
  if (s === undefined || s === 'none') return [];
  const l = s.split('+');
  if (!l.every((x) => re.test(x))) throw new Error(`${what}: ${s}`);
  return l;
}

/** The engine's own cli.js and node, for the throwaway snapshot unit and the broker. */
const engine = () => ({ node: process.execPath, engineCli: fileURLToPath(new URL('../cli.js', import.meta.url)) });

/**
 * A snapshot of unapproved server code (owner's condition): as a throwaway user, no network, no secrets, the code
 * read-only, nothing writable that the broker reads or runs; root reads one line of its output as data.
 */
function quarantine(instance: string, id: string, runtime: McpRuntime, codeDir: string): SnapshotResult {
  const r = runThrowawaySnapshot({ ...engine(), runtime, codeDir, unit: `${BRAND.cli}-mcp-snapshot-${instance}_${id}_${process.pid}` });
  return { snapshot: r.snapshot, error: r.error, withSecrets: false, network: [] };
}

function opts(args: string[]): Record<string, string> {
  const o: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('--') || args[i + 1] === undefined) throw new Error(`unexpected argument ${JSON.stringify(a)}`);
    o[a.slice(2)] = args[++i]!;
  }
  return o;
}

/** Who asked: the coordinator user sudo names, or root at a shell. */
const by = () => process.env.SUDO_USER || 'root';

async function readLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise((resolve) => rl.question(prompt, (a) => resolve(a.trim())));
  } finally {
    rl.close();
  }
}

export async function pluginsCommand(sub: string | undefined, rest: string[], instance: string | undefined): Promise<number> {
  let o: Record<string, string>;
  try {
    o = opts(rest);
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    return 2;
  }
  const source = () => ({ type: 'git' as const, url: o.url ?? '', sha: o.sha ?? '', ...(o.path ? { path: o.path } : {}) });
  const need = (...keys: string[]) => {
    const missing = keys.filter((k) => (k === 'instance' ? !instance : !o[k]));
    if (missing.length) throw new Error(`missing --${missing.join(', --')}`);
  };
  try {
    if (sub === 'fetch-job') {
      need('url', 'sha', 'out');
      const s = source();
      const why = sourceProblem(s);
      if (why) throw new Error(why);
      // Root's hosts only, by name; the name resolved once, to public addresses only, and git pinned to the one checked.
      const allowed = readPluginHosts();
      if (allowed.problem) throw new Error(`plugin hosts: ${allowed.problem}`);
      const bad = pluginUrlProblem(s.url, allowed.hosts);
      if (bad) throw new Error(bad);
      const host = new URL(s.url).hostname;
      fetchGitPlugin(s, o.out!, { pin: curlResolve(host, await pinnedAddress(host)) });
      console.log(`fetched ${s.url}${s.path ? ` (${s.path})` : ''} at ${s.sha}`);
      return 0;
    }
    if (sub === 'snapshot-job') {
      need('code', 'argv-b64');
      const argv = JSON.parse(Buffer.from(o['argv-b64']!, 'base64').toString('utf8')) as unknown;
      if (!Array.isArray(argv) || !argv.length || !argv.every((x) => typeof x === 'string')) throw new Error('--argv-b64 must be a JSON list of strings, base64');
      console.log(await snapshotJob(o.code!, argv as string[]));
      return 0;
    }
    if (sub === 'npm-job') {
      need('package', 'version', 'out');
      // The tree in <out>/tree, the result beside it, for root to read once it owns them.
      mkdirSync(o.out!, { recursive: true });
      // Root's registries only (owner's condition): the one asked for, or the first; its name public-only in DNS.
      const regs = readMcpRegistries();
      if (regs.problem) throw new Error(`MCP registries: ${regs.problem}`);
      const registry = o.registry ?? regs.registries[0];
      if (!registry || !regs.registries.includes(registry)) throw new Error(`${registry ?? 'no registry'} is not a registry MCP servers may come from (${regs.registries.join(', ') || 'none'})`);
      await pinnedAddress(registry);
      const r = fetchNpmServer(o.package!, o.version!, join(o.out!, 'tree'), registry);
      writeFileSync(join(o.out!, '.npm-result.json'), JSON.stringify(r) + '\n');
      console.log(`fetched ${r.package}@${r.version} (${r.integrity})${r.refusals.length ? `; refused: ${r.refusals.join('; ')}` : ''}`);
      return 0;
    }
    if (sub === 'show') {
      need('instance');
      const a = readAllowlist(instance!);
      for (const e of a.entries) {
        const r = e.record;
        const what = r.kind === 'plugin' ? `plugin  ${r.source.sha.slice(0, 12)}  ${r.tree}` : `mcp     ${r.runtime.type === 'npm' ? `${r.runtime.package}@${r.runtime.version}` : `${r.runtime.plugin}:${r.runtime.server}`}  ${r.snapshotHash ?? 'no snapshot yet'}`;
        console.log(`${r.id}  ${what}  roles ${r.roles.join(',')}  confirmed ${e.confirmed_at}`);
      }
      if (!a.entries.length) console.log('no approved plugins');
      return 0;
    }
    if (!['fetch-slot', 'ingest', 'stage', 'withdraw', 'remove', 'confirm', 'mcp-ingest-npm', 'mcp-preview', 'mcp-snapshot'].includes(sub ?? '')) {
      console.error(USAGE);
      return 2;
    }
    if (!isRoot()) throw new Error(`plugins ${sub} runs as root only`);
    if (sub === 'fetch-slot') {
      need('instance');
      takeFetchSlot(instance!, o.kind === 'snapshot' ? 'snapshot' : 'fetch');
      return 0;
    }
    need('instance', 'id');
    if (sub === 'ingest') {
      need('url', 'sha', 'from');
      const s = source();
      const why = sourceProblem(s);
      if (why) throw new Error(why);
      const p = ingest({ instance: instance!, id: o.id!, source: s, from: o.from! });
      console.log(p.materialized ? `preview of ${o.id}: passes inspection, ${p.materialized.tree}` : `preview of ${o.id}: refused\n  ${p.inspection.refusals.join('\n  ')}`);
      return 0;
    }
    if (sub === 'mcp-ingest-npm') {
      need('from');
      const r = JSON.parse(readFileSync(join(o.from!, '.npm-result.json'), 'utf8')) as NpmResult;
      // Copied into the preview first (root's, readable by the broker's user), then started from there in quarantine.
      let p = previewNpmServer({ instance: instance!, id: o.id!, from: join(o.from!, 'tree'), runtime: { type: 'npm', package: r.package, version: r.version, integrity: r.integrity, lockfile: r.lockfile, argv: r.argv }, refusals: r.refusals, snapshot: { snapshot: null, error: 'not started yet', withSecrets: false, network: [] } });
      if (!p.refusals.length) p = setPreviewSnapshot(instance!, o.id!, quarantine(instance!, o.id!, p.runtime, previewCodeDir(p)));
      console.log(p.refusals.length ? `refused: ${p.refusals.join('; ')}` : p.snapshot ? `previewed ${o.id}: ${p.snapshot.tools.length} tools` : `previewed ${o.id} without a snapshot: ${p.snapshotError}`);
      return 0;
    }
    if (sub === 'mcp-preview') {
      need('plugin', 'server');
      const a = readAllowlist(instance!).entries.find((e) => e.record.kind === 'plugin' && e.record.id === o.plugin);
      if (!a || a.record.kind !== 'plugin') throw new Error(`plugin ${o.plugin} is not approved for ${instance}`);
      const spec = a.record.mcpServers.find((x) => x.name === o.server);
      if (!spec) throw new Error(`plugin ${o.plugin} has no MCP server ${o.server}`);
      const runtime: McpRuntime = { type: 'plugin', plugin: a.record.id, tree: a.record.tree, server: spec.name, argv: spec.argv };
      const codeDir = mcpCodeDir(instance!, o.id!, runtime);
      if (treeHash(codeDir) !== a.record.tree) throw new Error(`plugin ${o.plugin}'s approved copy changed on disk`);
      const snap = quarantine(instance!, o.id!, runtime, codeDir);
      const p = previewPluginServer({ instance: instance!, id: o.id!, plugin: o.plugin!, server: o.server!, snapshot: snap });
      console.log(p.snapshot ? `previewed ${o.id}: ${p.snapshot.tools.length} tools` : `previewed ${o.id} without a snapshot: ${p.snapshotError}`);
      return 0;
    }
    if (sub === 'mcp-snapshot') {
      // The second snapshot (Q3): of an approved server, with its installed secrets and approved network, taken from its
      // approved code. It replaces the preview; staging and confirming it is a new approval.
      const e = readAllowlist(instance!).entries.find((x) => x.record.id === o.id && x.record.kind === 'mcp');
      if (!e) throw new Error(`${o.id} is not an approved MCP server of ${instance}`);
      const r = e.record as McpRecord;
      const codeDir = mcpCodeDir(instance!, r.id, r.runtime);
      if (treeHash(codeDir, r.runtime.type === 'npm' ? NPM_TREE_LIMITS : undefined) !== r.runtime.tree) throw new Error(`${o.id}'s approved code changed on disk`);
      // Approved code (its first confirm): the broker starts it as it would for a session, with its secrets and its
      // approved network, lists its tools and stops it. Root reads the reply as data.
      const got = await brokerSnapshot(instance!, r.id);
      const snap: SnapshotResult = { ...got, withSecrets: true, network: r.network };
      if (r.runtime.type === 'plugin') previewPluginServer({ instance: instance!, id: r.id, plugin: r.runtime.plugin, server: r.runtime.server, snapshot: snap });
      else {
        previewNpmServer({ instance: instance!, id: r.id, from: codeDir, runtime: { type: 'npm', package: r.runtime.package, version: r.runtime.version, integrity: r.runtime.integrity, lockfile: r.runtime.lockfile, argv: r.runtime.argv }, refusals: [], snapshot: snap });
      }
      console.log(snap.snapshot ? `snapshot of ${o.id} with its secrets: ${snap.snapshot.tools.length} tools; stage it to approve` : `no snapshot: ${snap.error}`);
      return 0;
    }
    if (sub === 'stage') {
      need('roles', 'digest');
      const roles = parseRoles(o.roles!);
      if (!roles) throw new Error('roles must be role names joined by +');
      const kind = readPreview(instance!, o.id!).kind;
      const mcp = kind === 'mcp' ? { network: plusList(o.network, HOST, 'network'), secrets: plusList(o.secrets, SECRET_NAME, 'secrets') } : undefined;
      if (kind === 'plugin' && (o.network !== undefined || o.secrets !== undefined)) throw new Error(`${o.id} is a plugin: hosts and secrets belong to an MCP server`);
      stage({ instance: instance!, id: o.id!, roles, digest: o.digest!, by: by(), ...(mcp ? { mcp } : {}) });
      console.log(`staged ${o.id} for ${instance} (${o.digest}); it is trusted for nothing until an admin confirms it at a root shell`);
      return 0;
    }
    if (sub === 'withdraw') {
      console.log(withdraw({ instance: instance!, id: o.id!, by: by() }) ? `withdrew ${o.id}` : `nothing staged for ${o.id}`);
      return 0;
    }
    if (sub === 'remove') {
      console.log(remove({ instance: instance!, id: o.id!, by: by() }) ? `removed ${o.id} from ${instance}'s allowlist` : `${o.id} is not in ${instance}'s allowlist`);
      return 0;
    }
    // confirm: an admin at a root shell. Never a coordinator through sudo: the helper has no confirm, and this refuses one.
    need('digest');
    if (/^wl-/.test(process.env.SUDO_USER ?? '')) throw new Error('confirm is an admin\'s, at a root shell: a coordinator may only stage');
    const plan = confirmPlan({ instance: instance!, id: o.id!, digest: o.digest! });
    console.error(`${describeRecord(plan.record, o.digest!)}\nstaged by ${plan.pending.staged_by} at ${plan.pending.staged_at}\n`);
    const typed = await readLine(`To confirm, type the plugin id (${o.id}): `);
    if (typed !== o.id) {
      console.error('not confirmed: nothing changed');
      return 1;
    }
    confirm({ instance: instance!, id: o.id!, digest: o.digest!, by: by() });
    console.log(`confirmed ${o.id} for ${instance}: agents in roles ${plan.record.roles.join(', ')} get it from their next run`);
    return 0;
  } catch (e) {
    console.error(e instanceof AllowlistError ? `allowlist: ${e.message}` : (e as Error).message);
    return 1;
  }
}

