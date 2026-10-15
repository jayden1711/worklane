import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { BRAND } from '../brand.js';
import { optimizeProblems } from '../optimize.js';
import { FILES } from './schema.js';
export class ConfigInvalid extends Error {
    errors;
    constructor(errors) {
        super(`${BRAND.configDir}/ is invalid:\n` + errors.map((e) => `  ${e.file}${e.path ? ` at ${e.path}` : ''}: ${e.message}`).join('\n'));
        this.errors = errors;
    }
}
const REQUIRED = ['config.yaml', 'agents.yaml', 'guardrails.yaml', 'tests.yaml'];
const OPTIONAL = ['review.yaml', 'deploy.yaml', 'app.yaml', 'benchmarks.yaml'];
function parseFile(text, file, errors) {
    const doc = parseDocument(text, { uniqueKeys: true });
    for (const e of doc.errors)
        errors.push({ file, path: '', message: e.message.split('\n')[0] });
    return doc.errors.length ? undefined : doc.toJS();
}
function validate(schema, value, file, errors) {
    const r = schema.safeParse(value);
    if (r.success)
        return r.data;
    for (const issue of r.error.issues)
        errors.push({ file, path: issue.path.join('.'), message: issue.message });
    return undefined;
}
/** Load and validate every config file. Throws ConfigInvalid listing all errors. */
export function loadConfig(root) {
    const dir = join(root, BRAND.configDir);
    if (!existsSync(dir))
        throw new ConfigInvalid([{ file: BRAND.configDir, path: '', message: `missing; run \`${BRAND.cli} install\`` }]);
    return configFrom(root, (file) => {
        const path = join(dir, file);
        return existsSync(path) ? readFileSync(path, 'utf8') : null;
    });
}
/**
 * The config committed at `rev` (e.g. origin/main), read from git and never from the working tree: the same files,
 * schema and checks as loadConfig. Throws ConfigInvalid listing all errors. `dir` stays the checkout's.
 */
export function loadConfigAt(root, rev) {
    const git = (...args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 });
    if (git('rev-parse', '-q', '--verify', `${rev}:${BRAND.configDir}`).status !== 0)
        throw new ConfigInvalid([{ file: BRAND.configDir, path: '', message: `missing at ${rev}` }]);
    const show = (file) => {
        const r = git('show', `${rev}:${BRAND.configDir}/${file}`);
        return r.status === 0 ? r.stdout : null;
    };
    const cfg = configFrom(root, show);
    // The role prompts at the same commit, so agents get the instructions that config goes with.
    const listed = git('ls-tree', '--name-only', `${rev}:${BRAND.configDir}/roles`);
    const roles = {};
    for (const name of listed.status === 0 ? listed.stdout.split('\n') : []) {
        if (!name.endsWith('.md'))
            continue;
        const text = show(`roles/${name}`);
        if (text !== null)
            roles[name.slice(0, -3)] = text;
    }
    return { ...cfg, roles };
}
/** Parse, validate and cross-check every config file `read` returns (null: the file is absent). */
export function configFrom(root, read) {
    const dir = join(root, BRAND.configDir);
    const errors = [];
    const out = {};
    for (const file of [...REQUIRED, ...OPTIONAL]) {
        const text = read(file);
        if (text === null) {
            if (REQUIRED.includes(file))
                errors.push({ file, path: '', message: 'missing' });
            continue;
        }
        const raw = parseFile(text, file, errors);
        if (raw !== undefined)
            out[file] = validate(FILES[file], raw, file, errors);
    }
    if (!errors.length)
        crossCheck(out, errors);
    if (errors.length)
        throw new ConfigInvalid(errors);
    return {
        root,
        dir,
        project: out['config.yaml'],
        agents: out['agents.yaml'],
        guardrails: out['guardrails.yaml'],
        tests: out['tests.yaml'],
        ...(out['review.yaml'] ? { review: out['review.yaml'] } : {}),
        ...(out['deploy.yaml'] ? { deploy: out['deploy.yaml'] } : {}),
        ...(out['app.yaml'] ? { app: out['app.yaml'] } : {}),
        ...(out['benchmarks.yaml'] ? { benchmarks: out['benchmarks.yaml'] } : {}),
    };
}
function crossCheck(out, errors) {
    const project = out['config.yaml'];
    const guardrails = out['guardrails.yaml'];
    const writers = new Set(project.owners.writers);
    if (!writers.has(project.owners.default)) {
        errors.push({ file: 'config.yaml', path: 'owners.default', message: 'default owner must be one of owners.writers' });
    }
    project.owners.areas.forEach((a, i) => {
        if (!writers.has(a.owner))
            errors.push({ file: 'config.yaml', path: `owners.areas.${i}.owner`, message: `${a.owner} is not in owners.writers` });
    });
    const ids = new Set();
    guardrails.rules.forEach((r, i) => {
        if (ids.has(r.id))
            errors.push({ file: 'guardrails.yaml', path: `rules.${i}.id`, message: `duplicate rule id ${r.id}` });
        ids.add(r.id);
        if ('connection' in r.match && !guardrails.fingerprints[r.match.connection.fingerprints]) {
            errors.push({ file: 'guardrails.yaml', path: `rules.${i}.match.connection.fingerprints`, message: `no fingerprint set named ${r.match.connection.fingerprints}` });
        }
    }); // Every optimize target names a declared benchmark (or the slowest test, with a command to run one).
    for (const e of optimizeProblems(project.optimize, out['benchmarks.yaml']))
        errors.push({ file: 'config.yaml', ...e });
}
//# sourceMappingURL=load.js.map