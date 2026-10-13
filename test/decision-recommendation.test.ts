// A decision's recommendation is one of its options or nothing (src/decision-ask.ts); prose, from an agent or
// stored by an older engine, is shown as wrapped text with Show more, never as a one-line pill cut mid-sentence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { findChrome, launchChrome, until, type Cdp } from '../src/browser/cdp.js';
import { loadConfig } from '../src/config/load.js';
import { startDashboard } from '../src/dashboard.js';
import { RECOMMENDATION_PREFIX, settleRecommendation } from '../src/decision-ask.js';
import { seedDemo } from '../src/demo.js';
import { EventLog } from '../src/events/log.js';
import { INVESTIGATION_OPTIONS, INVESTIGATION_SCHEMA, WORKER_SCHEMA } from '../src/roles.js';
import { REAL_CHROME_TIMEOUT, realChromeTests } from './browser-helpers.js';
import { exampleRoles, repoRoot } from './helpers.js';

/** A long prose recommendation, as an older engine stored it (the one seen cut at "reconcile.js:472 (pin"). */
const LONG_PROSE =
  'Release the stale claim in the first sweep instead of the second: the lock is only freed in reconcile.js:472 (pinned by the lease check) after a second sweep, so a coordinator that crashes between sweeps leaves the task claimed until its lease expires an hour later. ' +
  'Free it as soon as the lease holder is gone, keep the lease check for live holders, and add a test that stops the holder between two sweeps and expects the next sweep to free the task, so the next change to the reconciler keeps it that way. ' +
  'Nothing else in the reconciler needs to change; the retry window and the lease length can stay as they are.';

test('a recommendation that is not one of the options moves, whole, into the detail and is left empty', () => {
  assert.deepEqual(settleRecommendation(['approve-fix', 'investigate-more', 'close'], LONG_PROSE, ['confidence high']), {
    recommendation: '',
    receipts: ['confidence high', `${RECOMMENDATION_PREFIX}${LONG_PROSE}`],
  });
  // An option stays (spaces around it aside), and nothing recommended adds nothing.
  assert.deepEqual(settleRecommendation(['approve', 'reject'], ' approve ', ['head abc']), { recommendation: 'approve', receipts: ['head abc'] });
  assert.deepEqual(settleRecommendation(['approve', 'reject'], '', []), { recommendation: '', receipts: [] });
  // Close to an option is not an option.
  assert.deepEqual(settleRecommendation(['approve', 'reject'], 'Approve', []), { recommendation: '', receipts: [`${RECOMMENDATION_PREFIX}Approve`] });
});

test('the roles that ask put an option in the recommendation: an enum where the options are fixed', () => {
  const inv = INVESTIGATION_SCHEMA.properties.recommended;
  assert.deepEqual([...inv.enum], [...INVESTIGATION_OPTIONS]);
  assert.ok((INVESTIGATION_SCHEMA.required as readonly string[]).includes('recommended'));
  const ask = WORKER_SCHEMA.properties.ask.properties;
  assert.match(ask.recommendation.description, /copied exactly from options/);
  assert.ok('detail' in ask, "the worker's reasoning has its own field");
});

test("the dashboard's prefix for a recommendation's detail line is the engine's", async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(repoRoot, 'web', 'src', 'pages', 'Decisions.tsx'), 'utf8');
  assert.ok(src.includes(`export const RECOMMENDATION_PREFIX = ${JSON.stringify(RECOMMENDATION_PREFIX).replace(/"/g, "'")};`), 'web/src/pages/Decisions.tsx has the same prefix');
});

realChromeTests();
const chrome = findChrome(process.env.CHROME);
const built = existsSync(join(repoRoot, 'dist', 'web', 'index.html'));

test(
  'Inbox and Decisions in a real Chrome: prose wraps, whole, clamped to four lines at a word, with Show more; the pill is only for an option',
  { timeout: REAL_CHROME_TIMEOUT, skip: (!chrome && 'no Chrome or Chromium') || (!built && 'web UI not built (npm run build:web)') || (process.platform === 'win32' && 'checked on macOS and Linux') },
  async () => {
    const prev = process.env[`${BRAND.envPrefix}_STATE_DIR`];
    process.env[`${BRAND.envPrefix}_STATE_DIR`] = mkdtempSync(join(tmpdir(), 'rec-statedir-'));
    const demo = await seedDemo(join(mkdtempSync(join(tmpdir(), 'rec-demo-')), 'demo')).finally(() => {
      if (prev === undefined) delete process.env[`${BRAND.envPrefix}_STATE_DIR`];
      else process.env[`${BRAND.envPrefix}_STATE_DIR`] = prev;
    });
    // An event an older engine stored: prose straight in the recommendation. And one whose recommendation is an option.
    const log = new EventLog(demo.eventsDb);
    log.append('decision.asked', { id: 'd-old-prose', kind: 'question', issue: null, owner: 'example-owner', question: 'How should this proceed?', options: ['approve-fix', 'investigate-more', 'close'], recommendation: LONG_PROSE, receipts: ['confidence high'] }, 'coordinator');
    log.append('decision.asked', { id: 'd-option', kind: 'question', issue: null, owner: 'example-owner', question: 'Which export format?', options: ['csv', 'json'], recommendation: 'csv', receipts: [] }, 'coordinator');
    log.close();
    const d = await startDashboard({ root: demo.root, cfg: loadConfig(demo.root), eventsDb: demo.eventsDb, stateDir: mkdtempSync(join(tmpdir(), 'rec-state-')), user: 'example-owner', roleOf: exampleRoles, slotsDir: mkdtempSync(join(tmpdir(), 'rec-slots-')) });
    const b = await launchChrome(chrome!, { width: 1280, height: 1000 });
    try {
      const cdp = b.cdp;
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      const base = d.url.split('/?')[0]!;
      const token = d.url.split('?t=')[1]!;
      let first = true;
      for (const page of ['decisions', 'inbox']) {
        await cdp.send('Page.navigate', { url: `${base}/${page}${first ? `?t=${token}` : ''}` });
        first = false;
        await until(`the ${page} page's two decisions`, () => js<boolean>(cdp, `!!document.querySelector('[data-testid="page-${page}"] [data-decision="d-old-prose"]') && !!document.querySelector('[data-decision="d-option"]')`), 20_000);
        const card = `document.querySelector('[data-testid="page-${page}"] [data-decision="d-old-prose"]')`;
        const seen = await js<{ pill: number; text: string; clamp: string; lines: number; overflows: boolean; wraps: boolean; toggle: string | null; shown: string; next: string }>(
          cdp,
          `(() => {
            const card = ${card};
            const p = card.querySelector('[data-testid="decision-recommendation-text"]');
            const pill = card.querySelectorAll('[data-testid="decision-recommended"]').length;
            if (!p) return { pill, text: card.textContent, clamp: '', lines: 0, overflows: false, wraps: false, toggle: null, shown: '', next: '' };
            const cs = getComputedStyle(p);
            const line = parseFloat(cs.lineHeight);
            // The last character that shows, and the one after it: a clamp ends a line between words, never inside one.
            const node = [...p.childNodes].find((n) => n.nodeType === 3 && n.textContent.length > 100);
            const bottom = p.getBoundingClientRect().bottom + 0.5;
            const r = document.createRange();
            let last = -1;
            for (let i = 0; i < node.textContent.length; i++) {
              r.setStart(node, i); r.setEnd(node, i + 1);
              const rect = r.getClientRects()[0];
              if (!rect || rect.width === 0) continue;
              if (rect.bottom <= bottom) last = i; else break;
            }
            const t = node.textContent;
            return {
              pill,
              text: p.textContent,
              clamp: cs.webkitLineClamp,
              lines: Math.round(p.clientHeight / line),
              overflows: p.scrollHeight > p.clientHeight + 1,
              wraps: p.scrollWidth <= p.clientWidth + 1 && p.getBoundingClientRect().right <= card.getBoundingClientRect().right,
              toggle: card.querySelector('[data-testid="decision-recommendation-toggle"]')?.textContent ?? null,
              shown: t.slice(Math.max(0, last - 15), last + 1),
              next: t[last + 1] ?? '',
            };
          })()`,
        );
        assert.equal(seen.pill, 0, `${page}: prose is not a pill`);
        assert.ok(seen.text.includes(LONG_PROSE), `${page}: the whole recommendation is in the page`);
        assert.equal(seen.clamp, '4', `${page}: clamped by CSS to four lines`);
        assert.equal(seen.lines, 4, `${page}: four lines show`);
        assert.ok(seen.overflows && seen.wraps, `${page}: it wraps within the card and runs past four lines`);
        assert.equal(seen.toggle, 'Show more', `${page}: Show more`);
        assert.ok(/\s$/.test(seen.shown) || /^\s$/.test(seen.next), `${page}: the fourth line ends between words, not inside one ("…${seen.shown}" then "${seen.next}")`);

        await click(cdp, `${card}.querySelector('[data-testid="decision-recommendation-toggle"]')`);
        const open = await js<{ clamp: string; overflows: boolean; toggle: string | null; expanded: string | null }>(
          cdp,
          `(() => { const card = ${card}; const p = card.querySelector('[data-testid="decision-recommendation-text"]'); const t = card.querySelector('[data-testid="decision-recommendation-toggle"]'); return { clamp: getComputedStyle(p).webkitLineClamp, overflows: p.scrollHeight > p.clientHeight + 1, toggle: t?.textContent ?? null, expanded: t?.getAttribute('aria-expanded') ?? null }; })()`,
        );
        assert.deepEqual(open, { clamp: 'none', overflows: false, toggle: 'Show less', expanded: 'true' }, `${page}: Show more shows it all`);

        // An option is the pill, as it always was, and its button is the primary one.
        const option = await js<{ pill: string | null; prose: number; primary: string | null }>(
          cdp,
          `(() => { const card = document.querySelector('[data-testid="page-${page}"] [data-decision="d-option"]'); return { pill: card.querySelector('[data-testid="decision-recommended"]')?.textContent ?? null, prose: card.querySelectorAll('[data-testid="decision-recommendation"]').length, primary: card.querySelector('[data-option][title="recommended"]')?.getAttribute('data-option') ?? null }; })()`,
        );
        assert.deepEqual(option, { pill: 'Recommended: csv', prose: 0, primary: 'csv' }, `${page}: an option is a pill`);
      }
    } finally {
      await b.close();
      await d.close();
    }
  },
);

async function js<T>(cdp: Cdp, expression: string): Promise<T> {
  const r = await cdp.send<{ result: { value: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}

/** A real mouse click at the element's centre. */
async function click(cdp: Cdp, element: string) {
  const at = await js<{ x: number; y: number }>(cdp, `(() => { const e = ${element}; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await until('the click to land', () => js<boolean>(cdp, `${element}?.getAttribute('aria-expanded') === 'true'`), 5_000);
}
