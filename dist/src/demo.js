// A self-contained demo: a copy of the example project with a local "GitHub"
// remote and a file backlog, worked by the real coordinator with scripted
// agents, so the event log (and the dashboard) shows every state for real.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAND } from './brand.js';
import { FileBacklog } from './backlog/file.js';
import { recordBaseline } from './baseline.js';
import { loadConfig } from './config/load.js';
import { Coordinator } from './coordinator.js';
import { EventLog } from './events/log.js';
import { projectStateDir } from './guardrails/context.js';
import { childEnv } from './os/index.js';
import { FakeRunner } from './runner.js';
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function commitAll(cwd, msg) {
    git(cwd, 'add', '-A');
    git(cwd, '-c', 'user.email=agent@example.com', '-c', 'user.name=agent', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', msg);
}
const ISSUES = [
    { title: 'Totals count negative quantities', author: 'example-owner', labels: ['ready', 'size:S'], body: 'totalCents() adds items with qty <= 0.\n\n```done_when\n- test: test/price.test.js\n- repro: true\n```\n' },
    { title: 'Document the discount rounding rule', author: 'example-collaborator', labels: ['ready', 'size:S'], body: 'README should say discounts round to the nearest cent.\n\n```done_when\n- manual: "README states the rounding rule"\n```\n' },
    { title: 'Add the orders table', author: 'example-owner', labels: ['ready', 'size:M'], body: 'Migration for orders.\n\n```done_when\n- suite: changed\n```\n' },
    { title: 'Free shipping threshold', author: 'example-owner', labels: ['ready', 'size:S'], body: 'Free shipping over some amount.\n\n```done_when\n- suite: changed\n```\n' },
    { title: 'Are refunds ever counted twice?', author: 'example-owner', labels: ['ready', 'type:investigation', 'money-path'], body: 'Read-only: check the totals path.\n\n```done_when\n- manual: "findings posted with evidence"\n```\n' },
    { title: 'Speed up totals for large carts', author: 'example-collaborator', labels: ['ready', 'ui', 'size:M'], body: 'Totals is slow.\n\n```done_when\n- suite: changed\n```\n' },
    { title: 'Please add crypto payments', author: 'stranger', labels: ['ready'], body: 'Drive-by request.\n\n```done_when\n- manual: "x"\n```\n' },
    { title: 'Make checkout nicer', author: 'example-owner', labels: ['ready'], body: 'Vague, no contract.' },
    { title: 'Show prices with a currency symbol', author: 'example-collaborator', labels: ['ready', 'ui', 'size:S'], body: 'Prefix with $.\n\n```done_when\n- suite: changed\n```\n' },
];
function agents() {
    return new FakeRunner((req) => {
        const brief = req.prompt;
        const lesson = { worked: 'read the code first', failed: '', fix: '' };
        if (req.role === 'evaluator-repro') {
            writeFileSync(join(req.cwd, 'test', 'repro-qty.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { totalCents } from '../src/price.js';\ntest('ignores non-positive quantities', () => { assert.equal(totalCents([{ cents: 100, qty: -2 }, { cents: 5, qty: 1 }]), 5); });\n");
            commitAll(req.cwd, 'repro');
            return { structured: { test_path: 'test/repro-qty.test.js', explanation: 'negative qty subtracts from the total' }, costUsd: 0.21 };
        }
        if (req.role === 'investigator') {
            return { structured: { summary: 'No: refunds go through a separate path and are never added to totals.', findings: [{ claim: 'totalCents only sums line items', evidence: 'src/price.js:3' }], recommendation: 'No fix needed; add a test that pins this.', confidence: 'high' }, costUsd: 0.34 };
        }
        if (req.role === 'evaluator-verdict') {
            return { structured: { patch_correct: true, test_correct: true, confidence: 'high', advice: '' }, costUsd: 0.18 };
        }
        // workers
        if (/negative quantities/.test(brief)) {
            const p = join(req.cwd, 'src', 'price.js');
            writeFileSync(p, readFileSync(p, 'utf8').replace('sum + cents * qty', 'sum + (qty > 0 ? cents * qty : 0)'));
            commitAll(req.cwd, 'Ignore non-positive quantities in totals');
            return { structured: { summary: 'Guarded qty; repro passes.', lesson }, costUsd: 0.42 };
        }
        if (/rounding rule/.test(brief)) {
            writeFileSync(join(req.cwd, 'README.md'), readFileSync(join(req.cwd, 'README.md'), 'utf8') + '\nDiscounts round to the nearest cent.\n');
            commitAll(req.cwd, 'Document discount rounding');
            return { structured: { summary: 'Documented.', lesson }, costUsd: 0.09 };
        }
        if (/orders table/.test(brief)) {
            mkdirSync(join(req.cwd, 'migrations'), { recursive: true });
            writeFileSync(join(req.cwd, 'migrations', '001_orders.sql'), 'CREATE TABLE orders (id int primary key, cents int not null);\n');
            commitAll(req.cwd, 'Add orders migration');
            return { structured: { summary: 'Migration added.', lesson }, costUsd: 0.37 };
        }
        if (/Free shipping/.test(brief)) {
            return { structured: { summary: 'Need the threshold.', lesson, ask: { question: 'What order total should get free shipping?', options: ['$50', '$75', '$100'], recommendation: '$50' } }, costUsd: 0.12 };
        }
        if (/Speed up totals/.test(brief)) {
            return { structured: { summary: 'Tried twice; the benchmark is not in the repo.', lesson }, costUsd: 0.55 }; // commits nothing: rejected until blocked
        }
        return { structured: { summary: 'done', lesson }, costUsd: 0.1 };
    });
}
export async function seedDemo(dir) {
    if (existsSync(dir))
        throw new Error(`${dir} already exists; pick a new directory`);
    mkdirSync(dir, { recursive: true });
    const remote = join(dir, 'remote.git');
    const seed = join(dir, 'seed');
    const root = join(dir, 'shop');
    cpSync(fileURLToPath(new URL('../../examples/basic', import.meta.url)), seed, { recursive: true });
    writeFileSync(join(seed, '.gitignore'), '.claude/worktrees/\n');
    // A main that's a little red, like real ones: one known failure for the baseline.
    writeFileSync(join(seed, 'test', 'legacy.test.js'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('legacy currency rounding', () => { assert.equal(0.1 + 0.2, 0.3); });\n");
    const cfgFile = join(seed, BRAND.configDir, 'config.yaml');
    writeFileSync(cfgFile, readFileSync(cfgFile, 'utf8').replace('land_mode: pr', 'land_mode: direct').replace('backlog: github', 'backlog: file'));
    const dep = join(seed, BRAND.configDir, 'deploy.yaml');
    writeFileSync(dep, 'version: 1\nenvironments:\n  - name: staging\n    trigger: "true"\n    verify: "git rev-parse origin/main"\n');
    git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    git(seed, 'init', '-q', '-b', 'main');
    commitAll(seed, 'Initial commit');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-q', 'origin', 'main');
    git(dir, 'clone', '-q', remote, root);
    for (const [k, v] of [['user.email', 'coordinator@example.com'], ['user.name', 'coordinator'], ['commit.gpgsign', 'false']])
        git(root, 'config', k, v);
    const cfg = loadConfig(root);
    const state = projectStateDir(root);
    const backlog = new FileBacklog(join(state, 'backlog.json'));
    const later = ISSUES.at(-1);
    for (const i of ISSUES.slice(0, -1))
        backlog.open(i);
    const eventsDb = join(state, 'events.db');
    const log = new EventLog(eventsDb);
    const run = spawnSync('node', ['--test', '--test-reporter=spec'], { cwd: root, encoding: 'utf8', env: childEnv() });
    recordBaseline(log, 'demo', git(root, 'rev-parse', 'HEAD'), run.status, `${run.stdout}${run.stderr}`, cfg.tests.failures);
    const slots = join(state, 'demo-slots');
    mkdirSync(slots, { recursive: true });
    writeFileSync(join(slots, 'config.json'), JSON.stringify({ max_agents: 4 }));
    const c = new Coordinator({ cfg, log, backlog, runner: agents(), repo: root, instance: 'demo@local', stateDir: state, slotsDir: slots, maxAttempts: 2, machine: { load: () => 1, disk: () => ({ freePct: 80, totalGb: 500 }) } });
    log.append('coordinator.started', { instance: 'demo@local', pid: process.pid, version: 'demo' }, 'demo@local');
    for (let i = 0; i < ISSUES.length + 3; i++) {
        await c.tick();
        await c.idle();
    }
    await c.tick(); // land what's queued
    await c.idle();
    // One more issue arrives after the crew is busy: seen, ready, not started yet.
    const n = backlog.open(later);
    log.append('issue.seen', { issue: n, title: later.title, labels: later.labels, author: later.author, owner: null, actionable: true, why: `opened by writer ${later.author}` }, 'demo@local');
    log.close();
    return { root, eventsDb, issues: ISSUES.length };
}
//# sourceMappingURL=demo.js.map