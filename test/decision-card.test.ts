// A decision card (Decisions and Inbox, #586): three plain lines first, in order (what happened, the recommended
// option by name, what each choice does), each option once with the recommended one highlighted, the evidence
// (findings, confidence, impact, receipts, the review level) behind a Details toggle, no row that says "not
// recorded", and no review level, done_when or question number without its plain meaning. Rendered from what a real
// dashboard serves: the decision fixture's every kind, and the demo's decisions. Who may answer is the server's
// (canAnswer), as before.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/brand.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { optionEffect } from '../src/decision-detail.js';
import { seedDemo } from '../src/demo.js';
import { EventLog } from '../src/events/log.js';
import { asPerson, exampleRoles, repoRoot } from './helpers.js';
import { decisionFixture, KINDS, WRITERS_ONLY } from './decision-fixture.js';

type Decision = { id: string; kind: string; issue: number | null; question: string; options: string[]; recommendation: string; receipts?: string[]; answer: unknown; canAnswer?: boolean; happened?: string; effects?: { option: string; does: string }[] };
type State = { decisions: Decision[]; inbox: { decisions: Decision[] } };
interface Render {
  renderDecisionCard(d: unknown, sending?: string, evidence?: unknown): string;
  renderDecisionDetail(d: unknown, prBody?: unknown, diff?: unknown): string;
  renderPage(name: string, state: unknown): string;
  renderWaiting(w: unknown, now?: number): string;
  termMeaning?: (term: string) => string | null;
}

let r: Render;
let f: Awaited<ReturnType<typeof decisionFixture>>;
/** The fixture's state for each person: the owner, a writer, and someone who may only look. */
const fixture: Record<'owner' | 'writer' | 'viewer', State> = {} as never;
/** The demo's state for the owner, with a high-risk landing waiting on its migration (as the render checks add). */
let demo: State;
const PEOPLE = { owner: 'example-owner', writer: 'example-collaborator', viewer: 'someone-else' } as const;

const get = async <T>(base: string, token: string, path: string, who: string) => {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}`, ...asPerson(who) } });
  assert.equal(res.status, 200, `${path} as ${who}`);
  return (await res.json()) as T;
};

before(async () => {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const out = mkdtempSync(join(tmpdir(), 'decision-card-'));
  await build({ configFile: false, root: join(repoRoot, 'web'), logLevel: 'silent', plugins: [react()], ssr: { noExternal: true }, build: { ssr: join(repoRoot, 'web', 'src', 'render-check.tsx'), outDir: out, emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'render-check.mjs' } } } });
  r = (await import(pathToFileURL(join(out, 'render-check.mjs')).href)) as Render;
  const g = globalThis as Record<string, unknown>;
  g.window ??= { location: { pathname: '/', search: '', hash: '' }, matchMedia: () => ({ matches: false }) };
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  for (const k of ['localStorage', 'sessionStorage']) Object.defineProperty(g, k, { value: storage, configurable: true, writable: true });

  f = await decisionFixture();
  for (const [role, login] of Object.entries(PEOPLE)) fixture[role as keyof typeof PEOPLE] = await get<State>(f.base_url, f.d.token, '/api/state', login);

  // The demo's coordinator keeps its state under the state dir: a temporary one, not the user's.
  const prev = process.env[`${BRAND.envPrefix}_STATE_DIR`];
  process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'decision-card-statedir-'));
  const seeded = await seedDemo(join(mkdtempSync(join(tmpdir(), 'decision-card-demo-')), 'demo')).finally(() => {
    if (prev === undefined) delete process.env[`${BRAND.envPrefix}_STATE_DIR`];
    else process.env[`${BRAND.envPrefix}_STATE_DIR`] = prev;
  });
  const log = new EventLog(seeded.eventsDb);
  log.append('review.level_set', { issue: 3, head: 'c'.repeat(40), level: 'L3', reasons: ['migrations'] }, 'demo@local');
  log.append('decision.asked', { id: 'demo-land', kind: 'land', issue: 3, owner: 'example-owner', question: 'Approve landing #3 (L3)?', options: ['approve', 'reject'], recommendation: 'approve', receipts: ['head cccccccc', 'migrations'] }, 'demo@local');
  log.close();
  const d = await startDashboard({ root: seeded.root, cfg: loadConfig(seeded.root), eventsDb: seeded.eventsDb, stateDir: mkdtempSync(join(tmpdir(), 'decision-card-state-')), user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'decision-card-slots-')) });
  try {
    demo = await get<State>(d.url.split('/?')[0]!, d.token, '/api/state', PEOPLE.owner);
  } finally {
    await d.close();
  }
});
after(() => f?.d.close());

// Reading the rendered markup: an element whole (to its matching close tag), its children, its text.
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const TAG = /<(\/?)([a-zA-Z][\w-]*)\b[^>]*?(\/?)>/g;
function elementAt(html: string, at: number): string {
  const re = new RegExp(TAG.source, 'g');
  re.lastIndex = at;
  let depth = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (VOID.has(m[2]!.toLowerCase()) || m[3]) {
      if (depth === 0) return m[0];
      continue;
    }
    depth += m[1] ? -1 : 1;
    if (depth === 0) return html.slice(at, re.lastIndex);
  }
  throw new Error(`no close for the element at ${at}: ${html.slice(at, at + 80)}`);
}
/** The first element whose opening tag has this text in it (an attribute, or `<details`). */
function element(html: string, has: string): string | null {
  const i = html.indexOf(has);
  return i < 0 ? null : elementAt(html, html.lastIndexOf('<', i));
}
const openTag = (el: string) => /^<[^>]*>/.exec(el)![0];
function children(el: string): string[] {
  const inner = el.slice(openTag(el).length, el.lastIndexOf('</'));
  const out: string[] = [];
  const re = new RegExp(TAG.source, 'g');
  for (let m = re.exec(inner); m; m = re.exec(inner)) {
    if (m[1]) continue;
    const kid = elementAt(inner, m.index);
    out.push(kid);
    re.lastIndex = m.index + kid.length;
  }
  return out;
}
const text = (html: string) =>
  html
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,:;?)])/g, '$1')
    .trim();
/** The markup with every Details toggle taken out: what a card shows before anyone opens it. */
function outsideDetails(html: string): string {
  for (let i = html.indexOf('<details'); i >= 0; i = html.indexOf('<details')) html = html.slice(0, i) + html.slice(i + elementAt(html, i).length);
  return html;
}
/** Each card on a page, by decision id. */
function cards(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/data-decision="([^"]+)"/g)) out.set(m[1]!, elementAt(html, html.lastIndexOf('<', m.index!)));
  return out;
}
const lineOf = (el: string) => /data-line="([a-z]+)"/.exec(openTag(el))?.[1] ?? /data-testid="([a-z-]+)"/.exec(openTag(el))?.[1] ?? openTag(el);
const open = (s: State) => s.decisions.filter((d) => !d.answer);
const byId = (s: State, id: string) => s.decisions.find((d) => d.id === id)!;
const detailOf = (id: string, who: string) => get<Record<string, unknown>>(f.base_url, f.d.token, `/api/decisions/${id}`, who);

test('a decision card leads with three plain lines', () => {
  const land = byId(fixture.owner, 'd-land');
  assert.equal(land.recommendation, 'approve', 'a landing whose recommendation is one of its options');
  for (const page of ['card', 'decisions', 'inbox']) {
    const html = page === 'card' ? r.renderDecisionCard(land) : cards(r.renderPage(page, fixture.owner)).get('d-land')!;
    // The card's body: on a card without one (before #586), the card itself.
    const body = element(html, 'data-testid="decision-body"') ?? children(html)[0]!;
    const kids = children(body);
    assert.deepEqual(kids.slice(0, 4).map(lineOf), ['decision-meta', 'happened', 'recommended', 'effects'], `${page}: the three lines come first, right under who and when`);
    assert.equal(text(kids[1]!), "An agent's change on #1 passed its checks and the evaluator, and it waits for your approval before it lands.", `${page}: line 1, what happened`);
    assert.equal(text(kids[2]!), 'Recommended: approve', `${page}: line 2 names the option`);
    assert.match(text(kids[3]!), /^approve 1 Queues the change, at the commit that was reviewed, to land on the default branch\. .* reject 2 Doesn't land it\. The issue gets a comment saying so/, `${page}: line 3, what each choice does`);
  }
  // What each choice does comes with the state (no detail request per card), as the detail says it.
  assert.deepEqual(land.effects, ['approve', 'reject'].map((option) => ({ option, does: optionEffect('land', option).does })));
  // Other kinds: an investigation's option, and a recommendation in words (not an option) said as it is.
  const lines = (id: string) => children(element(r.renderDecisionCard(byId(fixture.owner, id)), 'data-testid="decision-body"')!).slice(1, 4).map(text);
  assert.deepEqual(lines('d-inv').slice(0, 2), ['An investigation on #2 finished and asks how to go on: nothing is changed until you say.', 'Recommended: approve-fix']);
  assert.deepEqual(lines('d-ask').slice(0, 2), ['The agent working on #3 stopped to ask you rather than guess: Which refund threshold?', 'Recommended: The fixtures decide it.']);
  assert.doesNotMatch(lines('d-ask')[1]!, /in words, below/);
});

test('options shown once', async () => {
  let answerable = 0;
  let told = 0;
  for (const [who, s] of Object.entries(fixture)) {
    for (const d of open(s)) {
      const html = r.renderDecisionCard(d);
      const mayAnswer = d.canAnswer !== false;
      // No second copy of an option as a chip (a pill); the key hints stay.
      for (const m of html.matchAll(/<span[^>]*data-role="chip"[^>]*>([\s\S]*?)<\/span>/g)) assert.ok(!d.options.includes(text(m[1]!)), `${who} ${d.id}: "${text(m[1]!)}" is an option shown again as a chip`);
      for (const o of d.options) {
        const rows = [...html.matchAll(new RegExp(`<li[^>]*data-choice="${o.replace(/[$]/g, '\\$&')}"[^>]*>`, 'g'))];
        assert.equal(rows.length, 1, `${who} ${d.id}: "${o}" is one row`);
        const buttons = [...html.matchAll(new RegExp(`<button[^>]*data-option="${o.replace(/[$]/g, '\\$&')}"[^>]*>`, 'g'))].map((m) => m[0]);
        assert.equal(buttons.length, mayAnswer ? 1 : 0, `${who} ${d.id}: "${o}" is ${mayAnswer ? 'one button' : 'no button (the server says this person may not answer)'}`);
        const recommended = o === d.recommendation;
        assert.equal(/data-recommended="true"/.test(rows[0]![0]), recommended, `${who} ${d.id}: only the recommended row is marked`);
        if (mayAnswer) assert.equal(/\bbg-ink\b/.test(buttons[0]!) && /title="recommended"/.test(buttons[0]!), recommended, `${who} ${d.id}: only the recommended button is the primary one`);
      }
      if (mayAnswer) {
        answerable++;
        assert.match(html, /data-option="[^"]+"[^>]*>[\s\S]*?>1<\/span>/, `${who} ${d.id}: the key hint`);
      } else {
        told++;
        assert.match(html, /Waiting on @example-owner/);
      }
    }
  }
  assert.ok(answerable >= 5 && told >= 5, `both kinds of card were checked (${answerable} answerable, ${told} not)`);
  // The same permissions as before: a landing and a plan are the owners'; a question a writer may answer; a viewer none.
  assert.deepEqual(['d-land', 'd-plan', 'd-ask'].map((id) => byId(fixture.writer, id).canAnswer), [false, false, true]);
  assert.ok(open(fixture.viewer).every((d) => d.canAnswer === false));
  // The detail page too: each option once, as a button where the server allows it, never again as a pill.
  for (const kind of KINDS) {
    const d = (await detailOf(f.ids[kind], PEOPLE.owner)) as { options: { option: string }[]; canAnswer: boolean };
    const html = r.renderDecisionDetail(d);
    for (const { option } of d.options) {
      assert.equal((html.match(new RegExp(`data-choice="${option.replace(/[$]/g, '\\$&')}"`, 'g')) ?? []).length, 1, `${kind}: "${option}" is one row`);
      assert.equal((html.match(new RegExp(`data-option="${option.replace(/[$]/g, '\\$&')}"`, 'g')) ?? []).length, d.canAnswer ? 1 : 0, `${kind}: "${option}" as a button only where it can be answered`);
    }
    for (const m of html.matchAll(/<span[^>]*data-role="chip"[^>]*>([\s\S]*?)<\/span>/g)) assert.ok(!d.options.some((o) => text(m[1]!).startsWith(o.option)), `${kind}: "${text(m[1]!)}" repeats an option as a chip`);
    assert.doesNotMatch(html, /data-testid="decision-option-list"/, `${kind}: no second list of the options`);
  }
});

test('unrecorded rows are hidden', async () => {
  const unrecorded = /not recorded|none recorded|\bno \w+ recorded/i;
  for (const kind of KINDS) {
    for (const who of Object.values(PEOPLE)) {
      const d = (await detailOf(f.ids[kind], who)) as { prBody?: boolean; id: string };
      const pr = d.prBody && who !== PEOPLE.viewer ? await get(f.base_url, f.d.token, `/api/decisions/${d.id}/pr`, who) : undefined;
      const page = text(r.renderDecisionDetail(d, pr));
      assert.doesNotMatch(page, unrecorded, `${kind} as ${who}: the detail page says nothing is recorded: "${unrecorded.exec(page)?.[0]}" in …${page.slice(Math.max(0, (unrecorded.exec(page)?.index ?? 0) - 80), (unrecorded.exec(page)?.index ?? 0) + 40)}`);
      // A card's Details, with this detail read.
      const card = fixture.owner.decisions.find((x) => x.id === d.id);
      if (card) assert.doesNotMatch(text(r.renderDecisionCard(card, undefined, d)), unrecorded, `${kind} as ${who}: the card's Details`);
    }
  }
  // A PR merged on its own with no level or confidence recorded: no badge for either, rather than one saying so.
  const merged = { pr: 31, issue: 3, title: 'Migrate orders', url: 'https://example.test/pr/31', at: new Date().toISOString(), level: null, confidence: null };
  const html = r.renderWaiting({ at: new Date().toISOString(), items: [], mergedSince: new Date().toISOString(), merged: [merged], markdown: '' });
  assert.match(html, /data-testid="merged-item"[\s\S]*?Migrate orders/);
  assert.doesNotMatch(text(html), unrecorded, 'Waiting on you: merged since yesterday');
});

test('no unexplained jargon', () => {
  const term = /\b(?:L[0-3]|done_when|Q\d+)\b/g;
  let checked = 0;
  for (const [name, s] of [['the demo', demo], ['the fixture (owner)', fixture.owner], ['the fixture (viewer)', fixture.viewer]] as const) {
    assert.ok(name !== 'the demo' || open(s).some((d) => d.id === 'demo-land'), "the demo's landing waits for the owner");
    for (const page of ['decisions', 'inbox']) {
      for (const [id, card] of cards(r.renderPage(page, s))) {
        checked++;
        const shown = text(outsideDetails(card));
        for (const m of shown.matchAll(term)) {
          const meaning = r.termMeaning?.(m[0]) ?? null;
          const after = shown.slice(m.index! + m[0].length);
          assert.ok(meaning && (after.startsWith(`: ${meaning}`) || after.startsWith(` (${meaning})`)), `${name}, ${page}, ${id}: "${m[0]}" without its plain meaning next to it: …${shown.slice(Math.max(0, m.index! - 60), m.index! + 60)}…`);
        }
      }
    }
  }
  assert.ok(checked >= 10, `cards checked: ${checked}`);
  // The meanings are plain words.
  assert.equal(r.termMeaning?.('L3'), 'waits for you');
  assert.equal(r.termMeaning?.('done_when'), 'the checks that decide it is done');
  assert.equal(r.termMeaning?.('Q4'), 'question 4');
});

test('details hold the evidence', async () => {
  const card = async (id: string) => {
    const d = byId(fixture.owner, id);
    const html = r.renderDecisionCard(d, undefined, await detailOf(id, PEOPLE.owner));
    const details = element(html, '<details');
    assert.ok(details, `${id}: a Details toggle`);
    assert.doesNotMatch(openTag(details), /\sopen/, `${id}: closed until opened`);
    assert.match(details, /<summary[^>]*>Details<\/summary>/);
    return { inside: text(details), outside: text(outsideDetails(html)) };
  };
  const inv = await card('d-inv');
  for (const x of [WRITERS_ONLY[1]!, 'src/reconcile.js:472', 'the findings: confidence high', 'Findings (1)', 'confidence high', '1 finding(s)']) assert.ok(inv.inside.includes(x), `the investigation's Details hold "${x}": ${inv.inside}`);
  const land = await card('d-land');
  for (const x of ['the evaluator: confidence medium', WRITERS_ONLY[3]!, 'Money path: touches it (src/billing/refund.js)', 'Auth: touches it (src/auth/session.js)', "Secrets: doesn't touch it", 'L3: waits for you', 'money-path: src/billing/refund.js', 'Asked: Approve landing #1 (L3)?']) assert.ok(land.inside.includes(x), `the landing's Details hold "${x}": ${land.inside}`);
  // None of it on the card's face.
  for (const [c, name] of [[inv, 'investigation'], [land, 'landing']] as const) {
    for (const x of ['confidence', 'finding', 'src/', 'money-path', 'head ', WRITERS_ONLY[1]!, WRITERS_ONLY[3]!]) assert.ok(!c.outside.includes(x), `the ${name}'s card shows "${x}" outside Details: ${c.outside}`);
  }
});
