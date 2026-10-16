#!/usr/bin/env node
// CI only (ci-slow.yml, plugins-ui): screenshots of the Extend page for the Plugins PR, light and dark, desktop and
// phone, through scripts/dev/control-dashboard.mjs. The demo is a checkout, which has no plugins of its own, so the
// page's own /api/plugins answers are replaced in the browser by fixtures (below) after the page loads: what is shown
// is the real page rendering those answers. "Before" is the base branch's build: the sidebar without Extend.
//   node scripts/ci/plugins-ui-shots.mjs <out dir> <base checkout, built>
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [out, base] = process.argv.slice(2);
if (!out || !base) throw new Error('usage: plugins-ui-shots.mjs <out dir> <base checkout>');
mkdirSync(out, { recursive: true });
const sha = '9f8e7d6c5b4a39281706f5e4d3c2b1a098765432';
const digest = `sha256:${'5c1e'.repeat(16)}`;
const kitRecord = { v: 1, kind: 'plugin', instance: 'demo', id: 'review-kit', source: { type: 'git', url: 'https://github.com/example/review-kit.git', sha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' }, name: 'review-kit', version: '1.2.0', tree: `wl-tree-v1:sha256:${'ab'.repeat(32)}`, transform: [], components: { skills: ['review', 'summarize'], agents: [], commands: [], outputStyles: [], bin: [] }, mcpServers: [{ name: 'notes', argv: [], envNames: ['NOTES_TOKEN'], from: '.mcp.json' }], options: [], flags: [], roles: ['builder', 'reviewer'] };
const notesRecord = { v: 1, kind: 'mcp', instance: 'demo', id: 'review-kit-notes', runtime: { type: 'plugin', plugin: 'review-kit', server: 'notes', argv: [] }, secrets: ['NOTES_TOKEN'], network: ['api.notes.example'], snapshot: { serverName: 'notes', instructions: null, tools: [{ name: 'search', description: 'Search notes.' }, { name: 'fetch_page', description: 'Fetch a page.' }] }, roles: ['builder'], flags: [] };
const entries = [
  { id: 'review-kit', kind: 'plugin', label: 'review-kit 1.2.0 (a1b2c3d)', on: true, reach: ['skills: review, summarize', 'runs inside the agent sandbox; no secrets', 'MCP servers (each only once approved itself): notes'], digest, confirmed_at: new Date(Date.now() - 3 * 86400_000).toISOString(), staged_by: 'wl-demo', record: kitRecord },
  { id: 'review-kit-notes', kind: 'mcp', label: "review-kit's server notes", on: true, reach: ['network: api.notes.example', 'secrets: NOTES_TOKEN (names only)', 'tools: fetch_page, search', 'runs in its own sandbox, through the broker'], digest, confirmed_at: new Date(Date.now() - 2 * 86400_000).toISOString(), staged_by: 'wl-demo', record: notesRecord },
];
const diff = { added: ['skills/review/checklist.md'], removed: [], changed: ['skills/review/SKILL.md', '.claude-plugin/plugin.json'] };
const update = { diff, v: 1, kind: 'plugin', instance: 'demo', id: 'review-kit', source: { type: 'git', url: 'https://github.com/example/review-kit.git', sha }, fetched_at: new Date(Date.now() - 120_000).toISOString(), inspection: { name: 'review-kit', version: '1.3.0', refusals: [], skills: ['review', 'summarize'], agents: [], commands: [], bin: [], flags: ['skills/review/SKILL.md names https://docs.example/review'], mcpServers: [{ name: 'notes', envNames: ['NOTES_TOKEN'] }], files: Array.from({ length: 9 }, (_, i) => ({ path: `f${i}`, size: 100 })) }, materialized: { tree: `wl-tree-v1:sha256:${'cd'.repeat(32)}`, transform: ['removed .mcp.json'] } };
const owner = { available: true, role: 'owner', instance: 'demo', problem: null, offProblem: null, entries, pending: [], previews: [update], fetchStatus: null, blocked: null, requests: [], updates: { at: new Date().toISOString(), updates: [{ id: 'review-kit', kind: 'plugin', from: kitRecord.source.sha, to: sha, fetch: { kind: 'plugin', id: 'review-kit', url: kitRecord.source.url, sha } }] }, audit: [{ at: new Date(Date.now() - 2 * 86400_000).toISOString(), action: 'plugins.stage', login: 'example-owner' }, { at: new Date(Date.now() - 2 * 86400_000).toISOString(), root: true, by: 'root', action: 'plugins.demo.confirmed' }] };
const ownerEmpty = { ...owner, entries: [], previews: [], audit: [] };
const pending = { ...owner, previews: [], pending: [{ id: 'review-kit', roles: ['builder', 'reviewer'], digest, staged_at: new Date().toISOString(), staged_by: 'wl-demo', command: `sudo bash /opt/worklane/current/scripts/setup/plugins.sh confirm demo review-kit ${digest}` }] };
const writer = { available: true, role: 'writer', entries: entries.map(({ id, kind, label, on, reach, record }) => ({ id, kind, label, roles: record.roles, on, reach })), waiting: 1, problem: null };
const review = { ok: true, confirmed: false, digest, command: pending.pending[0].command, record: { ...kitRecord, source: { ...kitRecord.source, sha }, version: '1.3.0', tree: update.materialized.tree, transform: update.materialized.transform, flags: update.inspection.flags }, current: { digest, record: kitRecord } };

/** Replace the page's /api/plugins answers in this tab: GET with `view`, POST stage with `review`. */
const stub = (view) => ({ op: 'eval', expr: `(() => { const f = window.__origFetch ?? window.fetch; window.__origFetch = f; window.fetch = (u, i) => { const s = String(u); if (s.includes('/api/plugins/stage')) return Promise.resolve(new Response(${JSON.stringify(JSON.stringify(review))}, { status: 200, headers: { 'content-type': 'application/json' } })); if (s.includes('/api/plugins')) return Promise.resolve(new Response(${JSON.stringify(JSON.stringify(view))}, { status: 200, headers: { 'content-type': 'application/json' } })); return f(u, i); }; return true; })()` });

function run(name, commands, opts) {
  const file = join(out, `${name}.commands`);
  writeFileSync(file, commands.map((c) => JSON.stringify(c)).join('\n') + '\n');
  const args = ['scripts/dev/control-dashboard.mjs', 'run', file, ...opts];
  const r = execFileSync('node', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  writeFileSync(join(out, `${name}.jsonl`), r);
  process.stdout.write(`${name}: ${r.split('\n').filter(Boolean).length} steps\n`);
}

const shot = (n) => ({ op: 'screenshot', file: join(out, `${n}.png`) });
const settle = { op: 'wait', ms: 5600 }; // the page reads /api/plugins again every 5 s
for (const theme of ['light', 'dark']) {
  for (const [vp, size] of [['desktop', '1440x1000'], ['phone', '390x844']]) {
    const tag = `${theme}-${vp}`;
    const view = ['--theme', theme, '--viewport', size];
    const drawer = vp === 'phone' ? [{ op: 'click', target: 'testid:nav-menu' }, { op: 'wait', ms: 400 }] : [];
    // Before: the base branch's sidebar (no Extend).
    run(`before-sidebar-${tag}`, [{ op: 'open', page: 'board' }, ...drawer, shot(`before-sidebar-${tag}`)], [...view, '--engine', base, '--as', 'owner']);
    // After: the sidebar with Extend; the owner's empty state; the list with one update to review; Review open; the
    // machine step; the writer's read-only view.
    run(`after-${tag}`, [
      { op: 'open', page: 'board' }, ...drawer, shot(`after-sidebar-${tag}`),
      { op: 'open', page: 'extend' }, stub(ownerEmpty), settle, { op: 'wait', target: 'testid:plugins-empty' }, shot(`after-empty-${tag}`),
      stub(owner), settle, { op: 'wait', target: 'testid:plugin-preview' }, shot(`after-list-${tag}`),
      { op: 'click', target: 'testid:plugin-review-button' }, { op: 'wait', target: 'testid:plugin-review' }, shot(`after-review-${tag}`),
      stub(pending), settle, { op: 'wait', target: 'testid:plugins-pending' }, shot(`after-machine-step-${tag}`),
      { op: 'console' },
    ], [...view, '--as', 'owner']);
    run(`writer-${tag}`, [{ op: 'open', page: 'extend' }, stub(writer), settle, { op: 'wait', target: 'testid:plugins-writer-note' }, shot(`after-writer-${tag}`), { op: 'console' }], [...view, '--as', 'writer']);
  }
}
