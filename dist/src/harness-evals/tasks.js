// The harness eval suite's tasks: fixed past tasks, each a repository, the commit it started from, the issue as it
// was filed (with its done_when) and the merged outcome, for reference. The engine's own public tasks ship in
// templates/evals/tasks; tasks from private repositories live only in the held-out store (src/held-out.ts), in the
// coordinator's own state, never in a repository.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';
import { DoneWhen } from '../contract.js';
import { heldOutDir } from '../held-out.js';
import { ownerOnlyDir, writeOwnerOnly } from '../os/index.js';
export const HarnessTask = z.strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,80}$/, 'lowercase letters, digits and -'),
    /** owner/name on GitHub. */
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/name'),
    /** The commit the task started from: the replay's default branch. */
    base: z.string().regex(/^[0-9a-f]{40}$/, 'a full commit sha'),
    title: z.string().min(1).max(200),
    /** The issue text, without its done_when (rendered from `done_when` below). */
    body: z.string().min(1),
    done_when: DoneWhen.min(1),
    labels: z.array(z.string().min(1)).default(['size:S']),
    /** What actually merged, for reference only: never shown to the agents. */
    outcome: z.strictObject({ pr: z.number().int().positive(), merge: z.string().regex(/^[0-9a-f]{40}$/) }),
});
/** The public tasks the engine ships (package.json `files` includes templates/). */
export const PUBLIC_TASKS_DIR = fileURLToPath(new URL('../../../templates/evals/tasks', import.meta.url));
/** The held-out store's tasks: the coordinator's own state, owner-only. */
export const heldOutTasksDir = (stateDir, env = process.env) => join(heldOutDir(stateDir, env), 'tasks');
/** The issue body an agent sees: the task's text and its done_when block. Never the outcome. */
export function issueBody(t) {
    return `${t.body.trim()}\n\n\`\`\`done_when\n${stringifyYaml(t.done_when).trim()}\n\`\`\`\n`;
}
/**
 * A task file. A public one (`ownRepo` given) names no repository: it is always the engine's own, so a public task
 * from any other repository can't be written at all. Any other names its repository.
 */
export function parseTask(text, file, ownRepo) {
    const raw = parseYaml(text);
    if (ownRepo !== undefined && raw && typeof raw === 'object') {
        if ('repo' in raw)
            throw new Error(`${file}: a public task names no repo (it is always the engine's own); a task from another repository belongs in the held-out store`);
        if (!ownRepo)
            throw new Error(`${file}: the engine's own repository is unknown (package.json repository.url)`);
        raw.repo = ownRepo;
    }
    const r = HarnessTask.safeParse(raw);
    if (!r.success)
        throw new Error(`${file}: ${r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`);
    return r.data;
}
/** Every task file (*.yaml) in a directory, sorted by id; a missing directory has none. Public: the engine's own tasks. */
export function readTasks(dir, heldOut, ownRepo = engineRepo()) {
    if (!existsSync(dir))
        return [];
    return readdirSync(dir)
        .filter((f) => f.endsWith('.yaml'))
        .map((f) => ({ ...parseTask(readFileSync(join(dir, f), 'utf8'), join(dir, f), heldOut ? undefined : ownRepo), heldOut, file: join(dir, f) }))
        .sort((a, b) => a.id.localeCompare(b.id));
}
/**
 * The suite: the public tasks, then the held-out ones (when the store can be read). An id in both is refused, so a
 * private task can never be shadowed by, or mistaken for, a public one.
 */
export function loadSuite(o) {
    const notes = [];
    const pub = o.publicDirs.flatMap((d) => readTasks(d, false));
    // The held-out store, and any tasks dir the project's config names: each task names its repository, and none is
    // ever named in a PR comment.
    const held = [];
    for (const d of [...(o.projectDirs ?? []), ...(o.heldOutDir ? [o.heldOutDir] : [])]) {
        try {
            held.push(...readTasks(d, true));
        }
        catch (e) {
            notes.push(`tasks in ${d} not read: ${e.message.slice(0, 200)}`);
        }
    }
    const seen = new Set();
    for (const t of [...pub, ...held]) {
        if (seen.has(t.id))
            throw new Error(`two tasks have the id ${t.id}`);
        seen.add(t.id);
    }
    return { tasks: [...pub, ...held], notes };
}
/** Write a task into the held-out store (owner-only), for a private repository's task. */
export function writeHeldOutTask(dir, t) {
    ownerOnlyDir(dir);
    const f = join(dir, `${t.id}.yaml`);
    writeOwnerOnly(f, stringifyYaml(HarnessTask.parse(t)));
    return f;
}
/** The engine's own repository (owner/name), from its package.json: the only repository public tasks may come from. */
export function engineRepo(pkgJson = fileURLToPath(new URL('../../../package.json', import.meta.url))) {
    try {
        const url = JSON.parse(readFileSync(pkgJson, 'utf8')).repository?.url ?? '';
        return /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=tasks.js.map