// Adding a past task to the harness eval suite from a merged PR (read-only GitHub calls through gh): the commit the
// merge started from, the issue it closed (or the PR's own opening paragraph), the issue's done_when (or the PR's
// test files), and the merge for reference. A public task goes to the engine's templates/evals/tasks only when its
// repository is the engine's own and public; every other one goes to the held-out store, never a repository.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { parseContract } from '../backlog/types.js';
import { engineRepo, HarnessTask, writeHeldOutTask } from './tasks.js';

export type Gh = (args: string[]) => string;
export const gh: Gh = (args) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });

/** A test file by its name (a helper beside the tests is not one). */
const TEST_FILE = /\.(test|spec)\.[a-z]+$|_test\.[a-z]+$|(^|\/)test_[^/]+\.py$/;

/** Read a merged PR into a task (nothing is written). */
export function taskFromPr(repo: string, pr: number, o: { id?: string; gh?: Gh } = {}): HarnessTask {
  const run = o.gh ?? gh;
  const p = JSON.parse(run(['pr', 'view', String(pr), '-R', repo, '--json', 'title,body,state,mergeCommit,files,closingIssuesReferences,labels'])) as {
    title: string;
    body: string;
    state: string;
    mergeCommit: { oid: string } | null;
    files: { path: string }[];
    closingIssuesReferences: { number: number }[];
  };
  if (p.state !== 'MERGED' || !p.mergeCommit) throw new Error(`${repo}#${pr} is not merged`);
  const merge = p.mergeCommit.oid;
  const base = JSON.parse(run(['api', `repos/${repo}/commits/${merge}`])) as { parents: { sha: string }[] };
  const parent = base.parents[0]?.sha;
  if (!parent) throw new Error(`${repo}@${merge.slice(0, 8)} has no parent`);
  const issueN = p.closingIssuesReferences[0]?.number;
  const issue = issueN ? (JSON.parse(run(['issue', 'view', String(issueN), '-R', repo, '--json', 'title,body'])) as { title: string; body: string }) : null;
  const text = issue?.body ?? p.body.split(/\n\s*\n/)[0] ?? p.title;
  const contract = parseContract(text);
  const tests = p.files.map((f) => f.path).filter((f) => TEST_FILE.test(f));
  const done_when = contract.ok ? contract.done_when : tests.map((t) => ({ test: t }));
  if (!done_when.length) throw new Error(`${repo}#${pr}: no done_when in its issue and no test files in the PR; write the task by hand`);
  const body = text.replace(/```done_when\s*\n[\s\S]*?\n```/, '').trim() || p.title;
  return HarnessTask.parse({
    id: o.id ?? `${repo.split('/')[1]!.toLowerCase().replace(/[^a-z0-9-]/g, '-')}-${pr}`,
    repo,
    base: parent,
    title: issue?.title ?? p.title,
    body,
    done_when,
    labels: ['size:S'],
    outcome: { pr, merge },
  });
}

/**
 * Where a task may be kept. Public: only a task from the engine's own repository, and only while GitHub says that
 * repository is public. Anything else is held out.
 */
export function publicAllowed(repo: string, run: Gh = gh, own: string | null = engineRepo()): { ok: true } | { ok: false; why: string } {
  if (repo !== own) return { ok: false, why: `${repo} is not the engine's own repository (${own ?? 'unknown'}); its tasks stay in the held-out store` };
  const priv = run(['api', `repos/${repo}`, '--jq', '.private']).trim();
  return priv === 'false' ? { ok: true } : { ok: false, why: `${repo} is not public` };
}

export function saveTask(t: HarnessTask, where: { publicDir: string } | { heldOutDir: string }): string {
  if ('heldOutDir' in where) return writeHeldOutTask(where.heldOutDir, t);
  mkdirSync(where.publicDir, { recursive: true });
  const f = join(where.publicDir, `${t.id}.yaml`);
  // A public task names no repository: it is always the engine's own (tasks.ts parseTask).
  const rest: Partial<HarnessTask> = { ...t };
  delete rest.repo;
  writeFileSync(f, stringifyYaml(rest));
  return f;
}
