// Only buttons look like buttons, and a disabled button says why (#587): display chips (ValuePill, Badge) are
// flat, not pill-shaped; a button held by the server's own check shows that check's reason as its accessible
// description; a button this person can never use isn't drawn; and every bare `disabled=` in web/src is on a
// counted list that only shrinks.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { loadConfig } from '../src/config/load.js';
import { machineView, startDashboard } from '../src/dashboard.js';
import { EventLog } from '../src/events/log.js';
import { asPerson, exampleProject, exampleRoles, machineOwnersFile, repoRoot } from './helpers.js';

interface Render {
  renderChip(kind: 'value' | 'badge', tone?: string): string;
  renderButton(variant?: string): string;
  renderDecisionCard(d: unknown, sending?: string): string;
  renderMachine(data: unknown): string;
  renderClaudeAccount(data: unknown, now?: number): string;
  renderUnderUsage(usage: unknown[], current: string | null, o: { first: unknown; ignored: unknown; automation: unknown; study: unknown; state?: unknown }): string;
  renderPausedWork(usage: unknown[], current: string | null): string;
}
let r: Render;

before(async () => {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const out = mkdtempSync(join(tmpdir(), 'web-buttons-'));
  await build({ configFile: false, root: join(repoRoot, 'web'), logLevel: 'silent', plugins: [react()], ssr: { noExternal: true }, build: { ssr: join(repoRoot, 'web', 'src', 'render-check.tsx'), outDir: out, emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'render-check.mjs' } } } });
  r = (await import(pathToFileURL(join(out, 'render-check.mjs')).href)) as Render;
  const g = globalThis as Record<string, unknown>;
  g.window ??= { location: { pathname: '/', search: '', hash: '' }, matchMedia: () => ({ matches: false }) };
});

/** What makes an element look pressable here: the pill shape, a ring, a hover or press effect, the pointer. */
const BUTTON_LOOK = [/\brounded-full\b/, /\bshadow-(btn|hairline)\b/, /(^|\s)(hover|active):/, /\bcursor-pointer\b/];
const classOf = (html: string) => /class="([^"]*)"/.exec(html)?.[1] ?? '';

test('display chips are not button-shaped', () => {
  // The yardstick: every Button variant has the look.
  for (const v of ['default', 'outline', 'ghost', 'danger']) assert.ok(BUTTON_LOOK.some((re) => re.test(classOf(r.renderButton(v)))), `a ${v} Button looks pressable`);
  const chips = { 'ValuePill': r.renderChip('value'), 'ValuePill green': r.renderChip('value', 'green'), ...Object.fromEntries(['neutral', 'ok', 'warn', 'danger', 'info'].map((t) => [`Badge ${t}`, r.renderChip('badge', t)])) };
  for (const [name, html] of Object.entries(chips)) {
    assert.match(html, /^<span[^>]*data-role="chip"/, `${name} is a chip: ${html}`);
    assert.doesNotMatch(html, /role="button"|<button/, `${name} is no button`);
    for (const re of BUTTON_LOOK) assert.doesNotMatch(classOf(html), re, `${name} has no button look (${re}): ${classOf(html)}`);
  }
});

/** The button with this test id, its reason's element, and that element's text. */
function described(html: string, testId: string) {
  const tag = new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`).exec(html)?.[0];
  assert.ok(tag, `a ${testId} button is drawn`);
  const id = /aria-describedby="([^"]+)"/.exec(tag)?.[1];
  const text = id ? new RegExp(`id="${id.replace(/[^\w]/g, '\\$&')}"[^>]*>([\\s\\S]*?)</(p|span)>`).exec(html)?.[1]?.replaceAll('<!-- -->', '') : undefined;
  return { tag, disabled: /\sdisabled=""/.test(tag), id, text };
}

function machineSetup() {
  const dir = mkdtempSync(join(tmpdir(), 'web-buttons-machine-'));
  const slotsDir = join(dir, 'slots');
  mkdirSync(slotsDir);
  const { dir: root } = exampleProject();
  return { cfg: loadConfig(root), slotsDir, machine: { changesPath: join(dir, 'changes.jsonl'), updatesConfigPath: join(dir, 'updates.json'), updatesLogPath: join(dir, 'updates.jsonl') }, machineOwnersFile: machineOwnersFile('example-owner') };
}

test("a disabled machine button says the device isn't allowed", () => {
  const s = machineSetup();
  // The server's own view for a machine owner whose page didn't come from an allowed device.
  const away = JSON.parse(JSON.stringify(machineView({ ...s, user: 'example-owner', role: 'owner', deviceOk: false }))) as { canChange: boolean; why: string | null };
  assert.equal(away.canChange, true, 'a machine owner: the buttons are drawn');
  assert.match(away.why ?? '', /allowed devices \(dashboards\.sh --console-devices/, 'the reason is the refusal a change would get');
  const b = described(r.renderMachine(away), 'machine-setting-review-button');
  assert.ok(b.disabled, 'held');
  assert.ok(b.id, `aria-describedby names the reason: ${b.tag}`);
  assert.match(b.text ?? '', /^A machine change needs one of the console(&#x27;|')s allowed devices \(dashboards\.sh --console-devices/);
  // From an allowed device the device reason is gone (what is held then is only an unchanged value).
  const here = JSON.parse(JSON.stringify(machineView({ ...s, user: 'example-owner', role: 'owner', deviceOk: true })));
  assert.equal(here.why, null);
  assert.doesNotMatch(described(r.renderMachine(here), 'machine-setting-review-button').text ?? '', /device/);
  // A writer can never change the machine: no button at all, not a disabled one.
  const writer = JSON.parse(JSON.stringify(machineView({ ...s, user: 'example-collaborator', role: 'writer', deviceOk: true })));
  assert.doesNotMatch(r.renderMachine(writer), /<button[^>]*data-testid="machine-setting-(review-button|confirm)"/);
});

test('busy reason: a decision while its answer is saving says so, once, as every option\'s description', () => {
  const d = { id: 'd1', kind: 'question', issue: 7, owner: 'example-owner', question: 'Ship it?', options: ['approve', 'reject'], recommendation: 'approve', receipts: [], askedAt: new Date().toISOString(), answer: null, canAnswer: true };
  const idle = r.renderDecisionCard(d);
  assert.doesNotMatch(idle, /<button[^>]*disabled=""[^>]*data-testid="decision-option"/, 'nothing held while idle');
  const html = r.renderDecisionCard(d, 'approve');
  const opts = [...html.matchAll(/<button[^>]*data-testid="decision-option"[^>]*>/g)].map((m) => m[0]);
  assert.equal(opts.length, 2);
  const ids = new Set(opts.map((t) => (assert.match(t, /\sdisabled=""/), /aria-describedby="([^"]+)"/.exec(t)?.[1])));
  assert.equal(ids.size, 1, 'one reason for the row');
  assert.equal(described(html, 'decision-option').text, 'Saving…');
  assert.equal([...html.matchAll(/Saving…/g)].length, 1, 'said once');
});

test('a button this person can never use is not drawn; one held by the device says why (the Claude account)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-buttons-account-'));
  const { dir: root } = exampleProject();
  const cfg = loadConfig(root);
  const eventsDb = join(dir, 'events.db');
  new EventLog(eventsDb).close();
  // Both are machine owners; only example-owner owns this instance.
  const owners = machineOwnersFile('example-owner', 'example-collaborator');
  const d = await startDashboard({ root, cfg, eventsDb, stateDir: join(dir, 'state'), user: 'example-owner', roleOf: exampleRoles, machineOwnersFile: owners, claudeAccountDir: mkdtempSync(join(tmpdir(), 'web-buttons-acct-')), secretsHome: mkdtempSync(join(tmpdir(), 'web-buttons-home-')), slotsDir: join(dir, 'slots') });
  try {
    const base = d.url.split('/?')[0]!;
    const view = async (login: string) => {
      const res = await fetch(`${base}/api/claude-account`, { headers: { authorization: `Bearer ${d.token}`, ...asPerson(login) } });
      assert.equal(res.status, 200);
      return (await res.json()) as { allowed: boolean; everAllowed: boolean };
    };
    const writer = await view('example-collaborator');
    assert.deepEqual([writer.allowed, writer.everAllowed], [false, false], 'a writer here: no device would help');
    const writerHtml = r.renderClaudeAccount(writer);
    assert.doesNotMatch(writerHtml, /data-testid="claude-account-(refresh|switch)"/, 'never usable: not drawn');
    assert.match(writerHtml, /data-testid="claude-account-disabled"[^>]*>Read-only: only an owner of this instance/);
    const owner = await view('example-owner');
    assert.deepEqual([owner.allowed, owner.everAllowed], [false, true], 'the owner, from a device that is not allowed');
    const b = described(r.renderClaudeAccount(owner), 'claude-account-refresh');
    assert.ok(b.disabled);
    assert.match(b.text ?? '', /^Read-only: a machine change needs one of the console(&#x27;|')s allowed devices/);
  } finally {
    d.close();
  }
});

/** The owner's words (#587): an action that starts work, while its instance is paused on the usage limit. */
const PAUSED_HINT = 'paused: this takes effect when the instance resumes';
/** The owner's words (#664): an action that lands work while paused. Landing has no usage-pause check; agent runs wait. */
const LANDS_HINT = 'lands now; only agent runs wait';
/** The actions that start work in renderUnderUsage: File it, Add ready, an automation's Run now, a study's Start. */
const STARTS = ['first-task-file', 'issue-ignored-add-ready', 'automation-run', 'experiment-start'];
const usageOf = (instance: string, paused: boolean) => ({ instance, paused: paused ? { since: '2026-10-18T09:00:00Z', resetAt: '2026-10-18T14:00:00Z', source: 'claude', kind: 'five_hour' } : null, today: { runs: 3, limitHits: paused ? 1 : 0 }, lastHit: null });
const starters = {
  first: { local: true, why: null, template: { label: 'ready', body: 'b' }, tests: [] },
  ignored: { issues: [{ issue: 3, title: 'no label', url: 'https://github.com/o/r/issues/3', author: 'someone', labels: [], reasons: [{ kind: 'no-ready', text: 'no ready label', fix: 'add-ready' }] }], error: null, canFix: true, local: true },
  automation: { id: 'nightly', name: 'Nightly', owner: 'example-owner', enabled: true, trigger: { kind: 'schedule', cron: '0 3 * * *' }, mode: 'task', template: { title: 't', outcome: 'o', done_when: [] }, budget: { per_run_usd: 1, per_day_usd: 2 }, limits: { runs_per_day: 1, cooldown_minutes: 0 }, when: 'daily at 03:00', summary: [], next: null, today: { runs: 0, spentUsd: 0 }, runs: [], refused: [], pausedBy: null, webhook: null, waiting: [] },
  study: { id: 's1', goal: 'lower loss', kind: 'ml_train', screen: { margin: 0, seeds: 1 }, ladder: [], metric: { name: 'loss', direction: 'min', min_delta: 0 }, job: { max_minutes: 10, gpus: 1, output_gb: 1 }, budget: { gpu_hours_per_day: 1, agent_usd_per_day: 1, agent_usd_total: 1, max_jobs: 1 }, exploration: { share: 0.1, near_miss: 0 }, editable: ['train.py'], started: false, startRefused: null },
};

test('paused reason: a paused instance\'s start actions are not refused; each says it takes effect when the instance resumes', () => {
  // The owner's decision on #587: no new refusals while paused; the action stays usable and says when it takes effect.
  const html = r.renderUnderUsage([usageOf('example', true)], null, starters);
  for (const id of STARTS) {
    const b = described(html, id);
    assert.equal(b.disabled, false, `${id} is not refused while paused: ${b.tag}`);
    assert.ok(b.id, `${id}'s aria-describedby names the hint: ${b.tag}`);
    assert.equal(b.text, PAUSED_HINT, id);
  }
  assert.equal(html.split(PAUSED_HINT).length - 1, STARTS.length, 'only the actions that start work say it, once each');
  // Running: nothing said, nothing held (as before).
  const running = r.renderUnderUsage([usageOf('example', false)], null, starters);
  for (const id of STARTS) assert.deepEqual([described(running, id).disabled, described(running, id).id], [false, undefined], id);
  assert.doesNotMatch(running, /takes effect when the instance resumes/);
  // On a hub: the pause of the instance chosen, not of another one.
  const hub = [usageOf('a', false), usageOf('b', true)];
  assert.doesNotMatch(r.renderUnderUsage(hub, 'a', starters), /takes effect when the instance resumes/, 'a is running; b is paused');
  assert.equal(described(r.renderUnderUsage(hub, 'b', starters), 'automation-run').text, PAUSED_HINT);
});

test('paused reason: a land action says it lands now and only agent runs wait; a start action says it waits for the resume', () => {
  // The owner's decision on #664: landing has no usage-pause check, so a land button must not say it waits.
  const html = r.renderPausedWork([usageOf('example', true)], null);
  const land = described(html, 'paused-lands');
  assert.equal(land.disabled, false, `a land action is not refused while paused: ${land.tag}`);
  assert.equal(land.text, LANDS_HINT, `the land action's aria-describedby names the land text: ${land.tag}`);
  const start = described(html, 'paused-starts');
  assert.equal(start.disabled, false, `a start action is not refused while paused: ${start.tag}`);
  assert.equal(start.text, PAUSED_HINT, `the start action's aria-describedby names the resume text: ${start.tag}`);
  assert.equal(html.split(LANDS_HINT).length - 1, 1, 'the land text once, on the land action only');
  assert.equal(html.split(PAUSED_HINT).length - 1, 1, 'the resume text once, on the start action only');
  // Running: neither says anything.
  const running = r.renderPausedWork([usageOf('example', false)], null);
  for (const id of ['paused-lands', 'paused-starts']) assert.deepEqual([described(running, id).disabled, described(running, id).id], [false, undefined], id);
});

test('emergency stop is unchanged: its banner still says the coordinator halted and starts none, and it adds no pause hint or hold', () => {
  const state = { brand: { cli: 'wl' }, emergency: { inForce: { by: 'ops', at: '', reason: 'spend' }, halted: { at: new Date().toISOString(), running: 2 }, lastStop: null, lastResume: null } };
  const html = r.renderUnderUsage([usageOf('example', false)], null, { ...starters, state });
  assert.match(html.replaceAll('<!-- -->', ''), /data-testid="emergency-stop"[\s\S]*?Emergency stop in force[\s\S]*?by ops: spend\.[\s\S]*?This coordinator halted 2 running agent\(s\) [^<]* and starts none\. Agents on this\s+machine stay stopped until it(&#x27;|')s lifted on the machine with <code[^>]*>wl resume-all</);
  for (const id of STARTS) assert.deepEqual([described(html, id).disabled, described(html, id).id], [false, undefined], `${id}: as without the stop`);
  assert.doesNotMatch(html, /takes effect when the instance resumes/, 'an emergency stop is not a usage pause');
  // Paused on the usage limit as well: the stop's banner is the same banner.
  const banner = (h: string) => /<div role="alert"[^>]*data-testid="emergency-stop">[\s\S]*?<\/div>/.exec(h)?.[0];
  const both = r.renderUnderUsage([usageOf('example', true)], null, { ...starters, state });
  assert.ok(banner(html));
  assert.equal(banner(both), banner(html));
});

/**
 * Every `disabled=` in web/src without a `why` (or an aria-describedby) beside it, per file, as of #587. Fixed ones
 * leave the list: lower the count (or drop the file) in the same change. It never grows; a new held control passes
 * `why` to Button instead.
 */
const SILENT_DISABLED: Record<string, number> = {
  'web/src/App.tsx': 1,
  'web/src/components/Automations.tsx': 7,
  'web/src/components/ChatAttachments.tsx': 1,
  'web/src/components/ChatPanel.tsx': 4,
  'web/src/components/ClaudeProfiles.tsx': 11,
  'web/src/components/ClaudeSignin.tsx': 3,
  'web/src/components/ConfigPr.tsx': 4,
  'web/src/components/Conversations.tsx': 3,
  'web/src/components/DashboardKey.tsx': 1,
  'web/src/components/DiscordSetup.tsx': 11,
  'web/src/components/Experiments.tsx': 3,
  'web/src/components/FirstTask.tsx': 13,
  'web/src/components/FlakyPanel.tsx': 1,
  'web/src/components/InstanceSettings.tsx': 3,
  'web/src/components/LearningsPanel.tsx': 1,
  'web/src/components/LiveRun.tsx': 4,
  'web/src/components/Plugins.tsx': 6,
  'web/src/components/PolicyForm.tsx': 6,
  'web/src/components/Protection.tsx': 2,
  'web/src/components/RepoConfigForm.tsx': 10,
  'web/src/components/SetupConfig.tsx': 11,
  'web/src/components/SiriDevices.tsx': 1,
  'web/src/components/SourceSetup.tsx': 10,
  'web/src/components/UpdaterSetup.tsx': 6,
  'web/src/components/Usage.tsx': 1,
  'web/src/components/patterns.tsx': 1,
  'web/src/pages/Board.tsx': 4,
  'web/src/pages/FirstRun.tsx': 7,
  'web/src/pages/Setup.tsx': 14,
  'web/src/render-check.tsx': 1,
  'web/src/voice/Mic.tsx': 1,
  'web/src/voice/VoiceControl.tsx': 1,
  'web/src/voice/VoiceSettings.tsx': 2,
};
/** The list's total when it was made (155); lower it as the list shrinks, never raise it. */
const SILENT_CEILING = 155;

function silentDisabled(): Record<string, number> {
  const counts: Record<string, number> = {};
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : []));
  for (const file of walk(join(repoRoot, 'web', 'src'))) {
    const src = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = (n: ts.Node) => {
      if (ts.isJsxAttribute(n) && n.name.getText(src) === 'disabled') {
        const siblings = (n.parent as ts.JsxAttributes).properties;
        if (!siblings.some((p) => ts.isJsxAttribute(p) && ['why', 'aria-describedby'].includes(p.name.getText(src)))) {
          const key = relative(repoRoot, file).split('\\').join('/');
          counts[key] = (counts[key] ?? 0) + 1;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(src);
  }
  return counts;
}

test('no silently disabled buttons: every disabled= passes a why, or is on the list, which only shrinks', () => {
  const now = silentDisabled();
  const grew = Object.entries(now).filter(([f, n]) => n > (SILENT_DISABLED[f] ?? 0));
  assert.deepEqual(grew, [], 'a disabled control without a why: pass `why` (the reason, from the server where it knows it) to Button');
  const shrank = Object.entries(SILENT_DISABLED).filter(([f, n]) => n !== (now[f] ?? 0));
  assert.deepEqual(shrank.map(([f]) => [f, now[f] ?? 0]), [], 'fewer than listed: lower the list to these counts');
  const total = Object.values(SILENT_DISABLED).reduce((a, b) => a + b, 0);
  assert.ok(total <= SILENT_CEILING, `the list holds ${total}, over its ceiling ${SILENT_CEILING}: it only shrinks`);
});
