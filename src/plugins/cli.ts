// `<cli> plugins ...`: the root side of plugin approvals, as scripts/setup/plugins.sh and the machine helper call it.
//   plugins fetch-job --url <https> --sha <40 hex> [--path <dir>] --out <dir>     the throwaway user's fetch (no root)
//   plugins fetch-slot --instance <i>                                               root: take one of the hour's fetches
//   plugins ingest  --instance <i> --id <id> --url .. --sha .. [--path ..] --from <dir>   root: inspect, preview
//   plugins stage   --instance <i> --id <id> --roles <a+b> --digest sha256:<hex>   root (the helper's plugin-stage)
//   plugins withdraw --instance <i> --id <id>                                       root (the helper's plugin-withdraw)
//   plugins remove  --instance <i> --id <id>                                        root (the helper's plugin-remove)
//   plugins confirm --instance <i> --id <id> --digest sha256:<hex>                  root, an admin at a root shell only
//   plugins show    --instance <i>                                                  anyone: the allowlist, checked
import { createInterface } from 'node:readline';
import { isRoot } from '../os/index.js';
import { AllowlistError, parseRoles, readAllowlist } from './approval.js';
import { fetchGitPlugin, sourceProblem } from './fetch.js';
import { curlResolve, pinnedAddress, pluginUrlProblem, readPluginHosts } from './hosts.js';
import { confirm, confirmPlan, describeRecord, ingest, remove, stage, takeFetchSlot, withdraw } from './root-ops.js';

const USAGE = 'usage: plugins fetch-job|fetch-slot|ingest|stage|withdraw|remove|confirm|show [options] (see src/plugins/cli.ts)';

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
    if (sub === 'show') {
      need('instance');
      const a = readAllowlist(instance!);
      for (const e of a.entries) console.log(`${e.record.id}  ${e.record.source.sha.slice(0, 12)}  ${e.record.tree}  roles ${e.record.roles.join(',')}  confirmed ${e.confirmed_at}`);
      if (!a.entries.length) console.log('no approved plugins');
      return 0;
    }
    if (!['fetch-slot', 'ingest', 'stage', 'withdraw', 'remove', 'confirm'].includes(sub ?? '')) {
      console.error(USAGE);
      return 2;
    }
    if (!isRoot()) throw new Error(`plugins ${sub} runs as root only`);
    if (sub === 'fetch-slot') {
      need('instance');
      takeFetchSlot(instance!);
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
    if (sub === 'stage') {
      need('roles', 'digest');
      const roles = parseRoles(o.roles!);
      if (!roles) throw new Error('roles must be role names joined by +');
      stage({ instance: instance!, id: o.id!, roles, digest: o.digest!, by: by() });
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
