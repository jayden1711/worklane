// The dashboard on a phone, in a real headless Chrome (over the DevTools protocol, through
// scripts/dev/control-dashboard.mjs; no npm dependency): at 390 x 844, every page of the feature map
// fits the screen's width, every control is a 44 x 44 px tap target, and the navigation is reachable
// from the page header's menu button, in a drawer that closes on Escape, the overlay, its close button
// and a change of page, with focus moved into it and back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { webUiSkip } from './browser-helpers.js';
import { repoRoot } from './helpers.js';

const dir = join(repoRoot, 'scripts', 'dev');
const fm = (await import(pathToFileURL(join(dir, 'feature-map.mjs')).href)) as { loadFeatureMap: () => { pages: { id: string; route: string; sidebar: string | null }[] } };
const ctl = (await import(pathToFileURL(join(dir, 'control-dashboard.mjs')).href)) as { findChrome: (given?: string) => string | null };
const map = fm.loadFeatureMap();
const sidebarPages = map.pages.filter((p) => p.sidebar).length;

/** In the page: how wide it is against the screen, and every visible control smaller than 44 x 44 px (a link inside a sentence aside). */
const MEASURE = `(() => {
  const main = document.querySelector('main');
  const small = [...document.querySelectorAll('button, a[href], select, summary, [role="tab"], [role="option"], input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"])')]
    .filter((e) => {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height) return false;
      if (e.tagName === 'A' && getComputedStyle(e).display === 'inline') return false;
      return r.width < 43.5 || r.height < 43.5;
    })
    .map((e) => (e.getAttribute('data-testid') || e.getAttribute('aria-label') || (e.innerText || e.tagName).trim().slice(0, 30)) + ' ' + Math.round(e.getBoundingClientRect().width) + 'x' + Math.round(e.getBoundingClientRect().height));
  return { innerWidth, scrollWidth: document.documentElement.scrollWidth, mainScrollWidth: main ? main.scrollWidth : 0, mainWidth: main ? main.clientWidth : 0, small };
})()`;

/** The drawer, open: its links, where focus is, the button's state, and that it fits the screen. */
const DRAWER = `(() => {
  const d = document.getElementById('nav-drawer');
  const b = document.querySelector('[data-testid="nav-menu"]');
  const r = d ? d.getBoundingClientRect() : null;
  return {
    open: !!d,
    role: d && d.getAttribute('role'),
    links: d ? [...d.querySelectorAll('nav[aria-label="Pages"] a[data-testid^="nav-"]')].map((a) => a.getAttribute('href')) : [],
    focusInside: !!d && d.contains(document.activeElement),
    expanded: b && b.getAttribute('aria-expanded'),
    controls: b && b.getAttribute('aria-controls'),
    fits: !!r && r.left >= 0 && r.right <= innerWidth + 0.5 && r.top >= 0 && r.bottom <= innerHeight + 0.5,
    statusDot: !!d && !!d.querySelector('[data-testid="instance-status-dot"], [data-testid="instance-dot"]'),
  };
})()`;

/** The drawer, closed: gone, with focus back on the menu button. */
const CLOSED = `({ open: !!document.getElementById('nav-drawer'), focus: document.activeElement && document.activeElement.getAttribute('data-testid'), expanded: document.querySelector('[data-testid="nav-menu"]')?.getAttribute('aria-expanded'), path: location.pathname })`;

type Out = { line: number; ok: boolean; error?: string; value?: Record<string, unknown> & { small?: string[] } };

// Needs a built UI (npm run build:web) and a Chrome or Chromium; skipped otherwise, but never in CI (CI_REQUIRE_WEB).
const chrome = ctl.findChrome(process.env.CHROME);
test('on a 390 x 844 phone every page fits the screen with 44 px tap targets, and the navigation opens from the menu button', { skip: webUiSkip(chrome), timeout: 600_000 }, (t) => {
  const cmds: string[] = [];
  const what = new Map<number, { page: string; check: string }>();
  const add = (page: string, check: string, c: object) => {
    cmds.push(JSON.stringify(c));
    what.set(cmds.length, { page, check });
  };
  for (const p of map.pages) {
    add(p.id, 'open', { op: 'open', page: p.id });
    add(p.id, 'settle', { op: 'wait', ms: 250 });
    add(p.id, 'measure', { op: 'eval', expr: MEASURE });
    add(p.id, 'menu', { op: 'click', target: 'testid:nav-menu' });
    add(p.id, 'drawer', { op: 'eval', expr: DRAWER });
    add(p.id, 'drawer-measure', { op: 'eval', expr: MEASURE });
    add(p.id, 'escape', { op: 'key', key: 'Escape' });
    add(p.id, 'closed', { op: 'eval', expr: CLOSED });
  }
  // The other ways out: the overlay, the close button, a page picked in the drawer, and Search (the command menu, on the screen).
  add('board', 'open', { op: 'open', page: 'board' });
  add('board', 'menu', { op: 'click', target: 'testid:nav-menu' });
  // A tap on the overlay, to the right of the drawer (at most 85% of the width).
  add('board', 'overlay', { op: 'click', target: 'point:375,420' });
  add('board', 'settle', { op: 'wait', ms: 250 });
  add('board', 'closed-overlay', { op: 'eval', expr: CLOSED });
  add('board', 'menu', { op: 'click', target: 'testid:nav-menu' });
  add('board', 'close-button', { op: 'click', target: '#nav-drawer [data-testid="nav-drawer-close"]' });
  add('board', 'closed-button', { op: 'eval', expr: CLOSED });
  add('board', 'menu', { op: 'click', target: 'testid:nav-menu' });
  add('board', 'pick-health', { op: 'click', target: '#nav-drawer [data-testid="nav-health"]' });
  add('board', 'settle', { op: 'wait', ms: 400 });
  add('board', 'closed-route', { op: 'eval', expr: CLOSED });
  add('board', 'menu', { op: 'click', target: 'testid:nav-menu' });
  add('board', 'search', { op: 'click', target: '#nav-drawer [data-testid="search-button"]' });
  add('board', 'command-menu', { op: 'eval', expr: `(() => { const m = document.querySelector('[data-testid="command-menu"]'); const r = m && m.getBoundingClientRect(); return { drawer: !!document.getElementById('nav-drawer'), menu: !!m, fits: !!r && r.left >= 0 && r.right <= innerWidth + 0.5 }; })()` });
  add('board', 'console', { op: 'console' });

  const r = spawnSync(process.execPath, [join(dir, 'control-dashboard.mjs'), 'run', '-', '--viewport', '390x844', '--with-prs', '--with-incidents', ...(process.env.CHROME ? ['--chrome', process.env.CHROME] : [])], {
    input: `${cmds.join('\n')}\n`,
    encoding: 'utf8',
    timeout: 540_000,
  });
  const out = r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Out);
  assert.equal(out.length, cmds.length, `every command ran:\n${r.stdout}\n${r.stderr}`);
  const failed = out.filter((o) => !o.ok).map((o) => `${what.get(o.line)?.page} ${what.get(o.line)?.check}: ${o.error}`);
  assert.deepEqual(failed, [], 'every step ran');
  const at = (page: string, check: string) => out.filter((o) => what.get(o.line)?.page === page && what.get(o.line)?.check === check).map((o) => o.value!);

  const report: string[] = [];
  for (const p of map.pages) {
    const m = at(p.id, 'measure')[0]!;
    report.push(`${p.id} ${p.route}: scrollWidth ${m.scrollWidth} / innerWidth ${m.innerWidth}, main ${m.mainScrollWidth} / ${m.mainWidth}`);
    assert.equal(m.innerWidth, 390, `${p.id}: the phone's width`);
    assert.ok((m.scrollWidth as number) <= (m.innerWidth as number), `${p.id}: no horizontal page scroll (${m.scrollWidth} > ${m.innerWidth})`);
    assert.ok((m.mainScrollWidth as number) <= (m.mainWidth as number), `${p.id}: nothing in the page is wider than the screen (${m.mainScrollWidth} > ${m.mainWidth})`);
    assert.deepEqual(m.small, [], `${p.id}: every control is 44 x 44 px or more`);
    const d = at(p.id, 'drawer')[0]!;
    assert.equal(d.open, true, `${p.id}: the menu button opens the drawer`);
    assert.equal(d.role, 'dialog');
    assert.equal(d.expanded, 'true', `${p.id}: the menu button says the drawer is open`);
    assert.equal(d.controls, 'nav-drawer');
    assert.equal(d.focusInside, true, `${p.id}: focus moves into the drawer`);
    assert.equal(d.fits, true, `${p.id}: the drawer fits the screen`);
    assert.equal(d.statusDot, true, `${p.id}: the drawer has the status dot`);
    assert.equal((d.links as string[]).length, sidebarPages, `${p.id}: the drawer links to every sidebar page`);
    assert.deepEqual(at(p.id, 'drawer-measure')[0]!.small, [], `${p.id}: every control in the drawer is 44 x 44 px or more`);
    const c = at(p.id, 'closed')[0]!;
    assert.equal(c.open, false, `${p.id}: Escape closes the drawer`);
    assert.equal(c.focus, 'nav-menu', `${p.id}: focus goes back to the menu button`);
    assert.equal(c.expanded, 'false');
  }
  assert.equal(at('board', 'closed-overlay')[0]!.open, false, 'the overlay closes the drawer');
  assert.equal(at('board', 'closed-button')[0]!.open, false, 'the close button closes the drawer');
  assert.equal(at('board', 'closed-button')[0]!.focus, 'nav-menu');
  const route = at('board', 'closed-route')[0]!;
  assert.deepEqual([route.open, route.path, route.focus], [false, '/health', 'nav-menu'], 'picking a page closes the drawer and focus goes to the new page\'s menu button');
  assert.deepEqual(at('board', 'command-menu')[0], { drawer: false, menu: true, fits: true }, 'Search closes the drawer and opens the command menu, on the screen');
  assert.deepEqual((out.at(-1) as unknown as { errors: unknown[] }).errors, [], 'no console errors');
  // The widths, for the record.
  for (const line of report) t.diagnostic(line);
});
