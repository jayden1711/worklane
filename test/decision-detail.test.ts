// A decision's detail (GET /api/decisions/:id and its page, src/decision-detail.ts, web/src/pages/DecisionDetail.tsx):
// every kind renders its sections from a real dashboard's answer (one with nothing recorded is left out); a viewer
// never gets the context, a writer never
// the owner-only parts; the PR body's fail-without and never sections are read whole; nothing picked means it waits.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ifNothing, optionEffect, prSections } from '../src/decision-detail.js';
import { asPerson, repoRoot } from './helpers.js';
import { decisionFixture, KINDS, OWNER_ONLY, PR_BODY, WRITERS_ONLY } from './decision-fixture.js';

type Detail = Record<string, unknown> & { kind: string; withheld: string | null; diff?: string; prBody?: boolean };
interface Render {
  renderDecisionDetail(d: unknown, prBody?: unknown, diff?: unknown): string;
  DETAIL_SECTIONS: readonly string[];
}

let f: Awaited<ReturnType<typeof decisionFixture>>;
let r: Render;
const get = async (path: string, who: string) => {
  const res = await fetch(`${f.base_url}${path}`, { headers: { authorization: `Bearer ${f.d.token}`, ...asPerson(who) } });
  return { status: res.status, body: (await res.json()) as Detail & { error?: string } };
};

before(async () => {
  f = await decisionFixture();
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const out = mkdtempSync(join(tmpdir(), 'decision-render-'));
  await build({
    configFile: false,
    root: join(repoRoot, 'web'),
    logLevel: 'silent',
    plugins: [react()],
    ssr: { noExternal: true },
    build: { ssr: join(repoRoot, 'web', 'src', 'render-check.tsx'), outDir: out, emptyOutDir: true, rollupOptions: { output: { entryFileNames: 'render-check.mjs' } } },
  });
  // Imported as on a server (no window: the module reads none at load), then a location for what reads one rendering.
  r = (await import(pathToFileURL(join(out, 'render-check.mjs')).href)) as Render;
  const g = globalThis as Record<string, unknown>;
  g.window ??= { location: { pathname: '/', search: '', hash: '' }, matchMedia: () => ({ matches: false }) };
});
after(() => f?.d.close());

/** Each section's state on a rendered page: data-section -> data-section-state. */
const sections = (html: string) => Object.fromEntries([...html.matchAll(/data-section="([a-z-]+)" data-section-state="([a-z-]+)"/g)].map((m) => [m[1]!, m[2]!]));

test('every kind of decision renders, from a real dashboard\'s answer, for the owner: its sections in page order, none of them empty', async () => {
  for (const kind of KINDS) {
    const { status, body: d } = await get(`/api/decisions/${f.ids[kind]}`, 'example-owner');
    assert.equal(status, 200, `${kind}: ${JSON.stringify(d)}`);
    const pr = d.prBody ? (await get(`/api/decisions/${f.ids[kind]}/pr`, 'example-owner')).body : undefined;
    const html = r.renderDecisionDetail(d, pr ?? undefined);
    const s = sections(html);
    assert.deepEqual(Object.keys(s), r.DETAIL_SECTIONS.filter((x) => x in s), `${kind}: in page order`);
    for (const always of ['summary', 'asked', 'if-nothing', 'links']) assert.ok(always in s, `${kind}: the ${always} section`);
    assert.ok(Object.values(s).every((x) => ['shown', 'not-applicable', 'withheld'].includes(x)), `${kind}: a section with nothing recorded isn't drawn: ${JSON.stringify(s)}`);
    assert.match(html, new RegExp(`data-testid="decision-detail" data-kind="${kind === 'investigation' ? 'question' : kind}"`));
    assert.match(html, /data-testid="decision-if-nothing-text">No timeout: it waits\./, `${kind}: what happens if nothing is picked`);
    assert.match(html, /data-testid="decision-happened">[^<]{20,}/, `${kind}: a plain summary`);
    // The impact flags where the change's files are known: each of the three.
    if (kind === 'land' || kind === 'pr') for (const flag of ['money-path', 'auth', 'secrets']) assert.match(html, new RegExp(`data-flag="${flag}"`), `${kind}: the ${flag} flag`);
  }
});

test('each section shows its data where the log has it, and is left out where it hasn\'t', async () => {
  const one = async (kind: (typeof KINDS)[number]) => {
    const d = (await get(`/api/decisions/${f.ids[kind]}`, 'example-owner')).body;
    const pr = d.prBody ? (await get(`/api/decisions/${f.ids[kind]}/pr`, 'example-owner')).body : undefined;
    const html = r.renderDecisionDetail(d, pr);
    return { d, html, s: sections(html) };
  };
  const land = await one('land');
  // No PR yet: no CI and no PR body section (11 of the 13; test/decision-detail-chrome.test.ts counts them in Chrome).
  assert.deepEqual(land.s, { summary: 'shown', asked: 'shown', impact: 'shown', 'if-nothing': 'shown', findings: 'not-applicable', change: 'shown', verdict: 'shown', tests: 'shown', runs: 'shown', links: 'shown', diff: 'shown' });
  assert.match(land.html, /data-flag="money-path" data-touches="yes"[\s\S]*?src\/billing\/refund\.js/);
  assert.match(land.html, /data-flag="auth" data-touches="yes"/);
  assert.match(land.html, /data-flag="secrets" data-touches="no"/);
  assert.match(land.html, /review level L3/);
  assert.match(land.html, /data-testid="decision-confidence-reason">[\s\S]*?WRITERSONLY-REASON did not run the refund path/);
  assert.match(land.html, /test: fail[\s\S]*?OWNERONLY-TAIL/, "the owners see a check's output");
  assert.match(land.html, /data-testid="decision-tampered"[\s\S]*?OWNERONLY-TAMPER/);
  assert.match(land.html, /data-testid="decision-auth-failed"[\s\S]*?auth_failed:[\s\S]*?API Error: 401/, 'the run Claude refused the login on');
  assert.match(land.html, /data-testid="decision-auth-held"[\s\S]*?example@account/, 'the login held now');
  assert.match(land.html, /data-testid="decision-run"/);
  assert.match(land.html, /data-testid="decision-effects"[\s\S]*?approve[\s\S]*?Queues the change[\s\S]*?any other commit/, 'what approving does and what it can\'t');
  assert.match(land.html, /data-testid="decision-detail-option"/, 'the owner may answer a landing');

  const inv = await one('investigation');
  assert.equal(inv.s.findings, 'shown');
  assert.match(inv.html, /WRITERSONLY-CLAIM[\s\S]*?data-testid="decision-finding-at"[\s\S]*?src\/reconcile\.js:472/, 'file:line read from the evidence');
  const finding = /data-testid="decision-finding"[\s\S]*?<\/li>/.exec(inv.html)![0];
  assert.doesNotMatch(finding, /severity|confidence/, "a finding's severity and confidence aren't recorded: no badge for them");
  assert.match(inv.html, /Why:<\/span> (<!-- -->)?Free it in the first sweep\./, 'the recommendation with its reasoning');
  assert.match(inv.html, /never writes code by itself/);

  const q = await one('question');
  assert.match(q.html, /data-testid="decision-agent-summary"[\s\S]*?Need the threshold before the refund rule\./);
  assert.match(q.html, /Recommended:<\/span> (<!-- -->)?The fixtures decide it\./, 'a recommendation that is no option, in its words');
  assert.equal(q.s.verdict, 'not-applicable');

  const pr = await one('pr');
  assert.deepEqual([pr.s.ci, pr.s.change, pr.s.verdict, pr.s.tests, pr.s['pr-body'], pr.s.diff], ['shown', 'shown', 'shown', 'shown', 'shown', 'shown']);
  assert.match(pr.html, /data-testid="decision-ci-checks"[\s\S]*?test: pass[\s\S]*?lint: fail/, 'CI per required check');
  assert.doesNotMatch(pr.html, /data-testid="decision-confidence-reason"/, 'a verdict before #471 gave no reason: no line for it');
  assert.equal(Object.keys(pr.s).length, 13, "a held PR's page has every section (test/decision-detail-chrome.test.ts counts them in Chrome)");
  assert.match(pr.html, /data-testid="decision-fail-without"[\s\S]*?fails: 1 of 3/);
  assert.match(pr.html, /data-testid="decision-never"[\s\S]*?It never refunds twice\./);
  assert.match(pr.html, /data-flag="money-path" data-touches="yes"/, "a held PR's impact, from its files, now");
  assert.match(pr.html, /href="https:\/\/github\.com\/example\/shop\/pull\/\d+"[^>]*data-testid="decision-link-pr"/);
  assert.doesNotMatch(pr.html, /data-testid="decision-detail-option"/, 'a PR is answered on GitHub');

  const domain = await one('domain');
  assert.deepEqual([domain.s.change, domain.s.findings, domain.s.ci, domain.s['pr-body']], [undefined, 'not-applicable', undefined, undefined]);
  assert.equal(domain.s.impact, undefined, 'no change, so no files to say the impact of: no impact section');
  assert.doesNotMatch(domain.html, /data-flag=/);
});

test('role gating: a viewer never gets the context; a writer never the owner-only parts; the diff is the owners\'', async () => {
  const owner = (await get(`/api/decisions/${f.ids.land}`, 'example-owner')).body;
  const writer = (await get(`/api/decisions/${f.ids.land}`, 'example-collaborator')).body;
  const viewer = (await get(`/api/decisions/${f.ids.land}`, 'someone-else')).body;
  const json = (x: unknown) => JSON.stringify(x);

  for (const s of [...WRITERS_ONLY.slice(2), OWNER_ONLY.tail, OWNER_ONLY.tamper]) assert.ok(json(owner).includes(s), `the owner gets ${s}`);
  for (const s of WRITERS_ONLY.slice(2)) assert.ok(json(writer).includes(s), `a writer gets ${s}`);
  for (const s of Object.values(OWNER_ONLY)) assert.ok(!json(writer).includes(s), `a writer never gets ${s}`);
  assert.equal(writer.diff, 'owners-only');
  assert.equal(owner.diff, 'owner');

  assert.equal(viewer.withheld !== null, true);
  assert.deepEqual(Object.keys(viewer).sort(), ['answer', 'askedAt', 'canAnswer', 'id', 'ifNothing', 'issue', 'kind', 'options', 'owner', 'question', 'recommendation', 'withheld']);
  for (const id of Object.values(f.ids)) {
    const v = (await get(`/api/decisions/${id}`, 'someone-else')).body;
    for (const s of [...WRITERS_ONLY, ...Object.values(OWNER_ONLY), 'Need the threshold', 'Free it in the first sweep', 'example@account']) assert.ok(!json(v).includes(s), `a viewer never gets "${s}" (${id})`);
    assert.equal('context' in v || 'findings' in v || 'change' in v || 'runs' in v, false, `${id}: no context for a viewer`);
  }
  const vhtml = r.renderDecisionDetail(viewer);
  assert.deepEqual(Object.keys(sections(vhtml)), ['summary', 'if-nothing', 'links'], "a viewer's page: the question and its options, the wait and the links");
  assert.match(vhtml, /data-testid="decision-withheld"/);

  assert.equal((await get(`/api/decisions/${f.ids.land}/diff`, 'example-collaborator')).status, 403);
  assert.equal((await get(`/api/decisions/${f.ids.land}/diff`, 'someone-else')).status, 403);
  assert.equal((await get(`/api/decisions/${f.ids.pr}/pr`, 'someone-else')).status, 403);
  assert.equal((await get(`/api/decisions/${f.ids.pr}/pr`, 'example-collaborator')).status, 200);
  const diff = (await get(`/api/decisions/${f.ids.land}/diff`, 'example-owner')).body as unknown as { diff: string };
  assert.match(diff.diff, /\+\+\+ b\/src\/billing\/refund\.js[\s\S]*?\+export const refund/, 'the diff, base..head, from the checkout');
  assert.equal((await get('/api/decisions/no-such', 'example-owner')).status, 404);
  assert.equal((await get('/api/decisions/..%2F..%2Fx', 'example-owner')).status, 404);
  assert.equal((await get(`/api/decisions/${f.ids.land}/other`, 'example-owner')).status, 404);
});

test('a PR body\'s fail-without and never sections, whole, under any heading level; absent ones are null', () => {
  assert.deepEqual(prSections(PR_BODY), { failWithout: 'Without the fix, `node --test dist/test/refund.test.js` fails: 1 of 3.', never: '- It never refunds twice.' });
  assert.deepEqual(prSections('### Fail without\nA\n#### sub\nB\n### Next\nC\n\n**What this can never do**\nD'), { failWithout: 'A\n#### sub\nB', never: 'D' });
  assert.deepEqual(prSections(''), { failWithout: null, never: null });
  assert.deepEqual(prSections(null), { failWithout: null, never: null });
});

test('options say what they do and can\'t; nothing picked never times out', () => {
  for (const kind of ['land', 'question', 'domain', 'plan', 'intake', 'delegation', 'pr'] as const) {
    assert.match(ifNothing(kind, 3), /^No timeout: it waits\./);
    const e = optionEffect(kind, 'approve');
    assert.ok(e.does.length > 10 && e.cannot.length > 10, `${kind}: a does and a can't`);
  }
  assert.match(optionEffect('domain', 'allow-once').cannot, /Later runs may not/);
});
