// WHY: the first-run page's Repo config form (audit rows 13-15) changes the repo's config the only way it may
// change: a reviewed commit. The values are applied to the default branch's own files (comments kept), checked with
// the same loader the coordinator uses, and proposed as a PR from a branch of their own; nothing is pushed to the
// default branch, and nothing in the checkout is touched.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { BRAND } from './brand.js';
import { configFrom, loadConfig } from './config/load.js';
import { projectStateDir } from './guardrails/context.js';
import { createWorktree, removeWorktree } from './worktrees.js';
import { checkedPush } from './push-check.js';
import { listedModel, MODEL_TIERS } from './model-routing.js';
import { ROUTING } from './routing.js';
import { withToolPath } from './tool-path.js';
const HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** Where each value lives: its file and its YAML path. */
const WHERE = {
    writers: { file: 'config.yaml', path: ['owners', 'writers'] },
    required_checks: { file: 'config.yaml', path: ['required_checks'] },
    daily_budget_usd: { file: 'agents.yaml', path: ['daily_budget_usd'] },
    workers_count: { file: 'agents.yaml', path: ['roles', 'workers', 'count'] },
    workers_model: { file: 'agents.yaml', path: ['roles', 'workers', 'model'] },
    ci: { file: 'config.yaml', path: ['ci'] },
};
const KEYS = Object.keys(WHERE);
/**
 * WHY (#468): the models the form offers the workers, from the engine's own list (the tiers routing and the model cap
 * know), and the one the engine builds with by default; the page reads both from here, never a copy of its own.
 */
export const WORKER_MODELS = MODEL_TIERS;
export const DEFAULT_WORKER_MODEL = ROUTING.build.default;
export function repoConfigValues(cfg) {
    return { writers: [...cfg.project.owners.writers], required_checks: [...cfg.project.required_checks], daily_budget_usd: cfg.agents.daily_budget_usd, workers_count: cfg.agents.roles.workers?.count ?? 1, workers_model: cfg.agents.roles.workers?.model ?? DEFAULT_WORKER_MODEL, ci: cfg.project.ci ?? 'github' };
}
export const repoConfigForm = (cfg) => ({ values: repoConfigValues(cfg), owner: cfg.project.owners.default, branch: cfg.project.project.default_branch, repo: cfg.project.project.repo, models: WORKER_MODELS, defaultModel: DEFAULT_WORKER_MODEL, modelListed: listedModel(repoConfigValues(cfg).workers_model) });
export class ConfigChangeError extends Error {
}
const realGit = (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
function cleaned(v) {
    const out = {};
    const list = (x, what, ok) => {
        if (!Array.isArray(x) || !x.every((s) => typeof s === 'string'))
            throw new ConfigChangeError(`${what}: a list of names`);
        const l = [...new Set(x.map((s) => s.trim()).filter(Boolean))];
        const bad = l.filter((s) => !ok(s));
        if (bad.length)
            throw new ConfigChangeError(`${what}: not valid: ${bad.join(', ')}`);
        return l;
    };
    for (const k of Object.keys(v))
        if (!KEYS.includes(k))
            throw new ConfigChangeError(`not editable here: ${k}`);
    if (v.writers !== undefined)
        out.writers = list(v.writers, 'writers', (s) => HANDLE.test(s));
    // INVARIANT: a check name goes into YAML as a plain string; no newlines or control characters.
    if (v.required_checks !== undefined)
        out.required_checks = list(v.required_checks, 'required checks', (s) => s.length <= 200 && !/[\u0000-\u001f]/.test(s));
    if (v.daily_budget_usd !== undefined)
        out.daily_budget_usd = Number(v.daily_budget_usd);
    if (v.workers_count !== undefined)
        out.workers_count = Number(v.workers_count);
    if (v.workers_model !== undefined)
        out.workers_model = String(v.workers_model).trim();
    if (v.ci !== undefined) {
        if (v.ci !== 'github' && v.ci !== 'none')
            throw new ConfigChangeError('ci: github or none');
        out.ci = v.ci;
    }
    return out;
}
/** The default branch's config files with these values applied (only the files they change), and what changes. */
function edited(root, cfg, values, git) {
    const branch = cfg.project.project.default_branch;
    const show = (f) => {
        const r = git(['show', `origin/${branch}:${BRAND.configDir}/${f}`], root);
        return r.status === 0 ? r.stdout : null;
    };
    return applyConfigValues(show, repoConfigValues(cfg), values, `origin/${branch}`);
}
/**
 * The config files `show` gives with these values applied (only the files they change, comments kept), and what
 * changes. WHY (#468): the same edit for the default branch's config and for setup mode's held draft.
 */
export function applyConfigValues(show, now, values, where) {
    const v = cleaned(values);
    const docs = new Map();
    const changes = [];
    for (const k of KEYS) {
        if (v[k] === undefined || JSON.stringify(v[k]) === JSON.stringify(now[k]))
            continue;
        // INVARIANT (#468): the form proposes only a model the engine lists; a hand-edited one is kept as it is unless changed.
        if (k === 'workers_model' && !listedModel(v.workers_model))
            throw new ConfigChangeError(`worker model: not one the engine supports: ${v.workers_model.slice(0, 80)} (one of ${WORKER_MODELS.join(', ')}, or a full Anthropic model id)`);
        const { file, path } = WHERE[k];
        if (!docs.has(file)) {
            const text = show(file);
            if (text === null)
                throw new ConfigChangeError(`${where} has no ${BRAND.configDir}/${file}: the config isn't on the default branch yet`);
            docs.set(file, parseDocument(text));
        }
        const doc = docs.get(file);
        const from = doc.getIn(path);
        doc.setIn(path, v[k]);
        changes.push({ file: `${BRAND.configDir}/${file}`, key: path.join('.'), from: from?.toJSON?.() ?? from, to: v[k] });
    }
    if (!changes.length)
        throw new ConfigChangeError('nothing to change');
    const texts = Object.fromEntries([...docs].map(([f, d]) => [f, d.toString()]));
    return { texts, changes, read: (f) => texts[f] ?? show(f) };
}
/** What these values would change on the default branch, checked like any config; nothing is written. */
export function planConfigChange(o) {
    const e = edited(o.root, o.cfg, o.values, o.git ?? realGit);
    try {
        configFrom(o.root, e.read);
    }
    catch (err) {
        throw new ConfigChangeError(`refused: ${err.message.split('\n').slice(1).map((l) => l.trim()).join('; ') || err.message}`);
    }
    return e.changes;
}
/**
 * Propose the change as a PR: a scratch worktree of origin/<default>, the edited files, the config loaded from it,
 * one commit, pushed to a branch of its own (never the default branch), and a PR opened. The worktree is removed after.
 */
export function proposeConfigChange(o) {
    const git = o.io?.git ?? realGit;
    const gh = o.io?.gh ?? spawnGh;
    const base = o.cfg.project.project.default_branch;
    const repo = o.cfg.project.project.repo;
    const fetched = git(['fetch', '-q', 'origin', base], o.root);
    if (fetched.status !== 0)
        throw new ConfigChangeError(`git fetch origin ${base} failed: ${fetched.stderr.trim().split('\n')[0] ?? ''}`);
    const changes = planConfigChange({ root: o.root, cfg: o.cfg, values: o.values, git });
    const e = edited(o.root, o.cfg, o.values, git);
    const stamp = (o.io?.now ?? (() => new Date()))().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    const branch = `${CONFIG_BRANCH_PREFIX}${stamp}`;
    const head = git(['rev-parse', `origin/${base}`], o.root).stdout.trim();
    const wt = { repo: o.root, root: join(projectStateDir(o.root), 'worktrees'), stateDir: projectStateDir(o.root), setup: [] };
    const name = `config-${stamp}`;
    const path = createWorktree(wt, name, branch, head).path;
    try {
        for (const [f, text] of Object.entries(e.texts))
            writeFileSync(join(path, BRAND.configDir, f), text);
        loadConfig(path);
        const add = git(['add', '--', ...Object.keys(e.texts).map((f) => `${BRAND.configDir}/${f}`)], path);
        if (add.status !== 0)
            throw new ConfigChangeError(`git add failed: ${add.stderr.trim()}`);
        const msg = `Config from the first-run page: ${changes.map((c) => c.key).join(', ')}`;
        const commit = git(['commit', '-q', '-m', msg], path);
        if (commit.status !== 0)
            throw new ConfigChangeError(`git commit failed: ${(commit.stderr || commit.stdout).trim().split('\n')[0]}`);
        const sha = git(['rev-parse', 'HEAD'], path).stdout.trim();
        // INVARIANT: through checkedPush like every engine push: the push limits, and never the default branch.
        const push = checkedPush({ cwd: path, remote: 'origin', base: head, head: sha, ref: `refs/heads/${branch}`, limits: o.cfg.guardrails.push, guard: { defaultBranch: base, blocked: () => undefined } });
        if (!push.ok)
            throw new ConfigChangeError(`pushing ${branch} failed: ${'refused' in push ? push.refused.join('; ') : (push.error.split('\n')[0] ?? '')}`);
        const body = [`Proposed from the ${BRAND.name} first-run page by @${o.by}. Merge it to apply; nothing changes until then.`, '', '| file | key | from | to |', '|---|---|---|---|', ...changes.map((c) => `| ${c.file} | ${c.key} | \`${JSON.stringify(c.from)}\` | \`${JSON.stringify(c.to)}\` |`)].join('\n');
        const pr = gh(['pr', 'create', '--repo', repo, '--base', base, '--head', branch, '--title', msg, '--body', body], o.root);
        if (pr.status !== 0)
            throw new ConfigChangeError(`${branch} is pushed, but opening its PR failed: ${pr.stderr.trim().split('\n')[0] ?? ''}`);
        return { changes, branch, url: pr.stdout.trim().split('\n').pop() ?? '', head: sha };
    }
    finally {
        try {
            removeWorktree(wt, name);
        }
        catch {
            // already gone
        }
        git(['branch', '-D', branch], o.root);
    }
}
function spawnGh(args, cwd) {
    const r = spawnSync('gh', args, { cwd, encoding: 'utf8', timeout: 60_000, env: withToolPath() });
    return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.error ? r.error.message : (r.stderr ?? '') };
}
/** The branch prefix the form proposes from: the only PRs its Merge takes. */
export const CONFIG_BRANCH_PREFIX = `${BRAND.cli}/config-`;
//# sourceMappingURL=config-change.js.map