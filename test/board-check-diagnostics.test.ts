// #639: test/dashboard-switch-speed.test.ts failed rarely on "busy's Board after its fresh answer" with no word on
// which part of the check failed. These check what such a failure now says, without a browser: explainBoard names
// each failing part from a snapshot, and the in-page parts (NOT_SHOWN_WHY, BOARD_SNAPSHOT) run against a fake page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { BOARD_CARDS, BOARD_SNAPSHOT, CURRENT_ROWS, explainBoard, NOT_SHOWN_WHY, type BoardSnapshot } from './browser-helpers.js';

const SHOWN: BoardSnapshot = { path: '/', board: true, cards: 3, instances: ['busy'], shown: 3, notShown: [], current: ['busy'], errors: [], updating: false };

/** The parts explainBoard's verdict names as failed ("failed: a, b; ..."). */
function failedParts(message: string): string[] {
  const m = /^[^;]*: failed: ([^;]*);/.exec(message);
  return m ? m[1]!.split(', ') : [];
}

test('#639 a false Board check names exactly the part that failed, and marks it [FAIL] beside the others [ok]', () => {
  const cases: { snap: Partial<BoardSnapshot>; parts: string[]; says: RegExp[] }[] = [
    { snap: { cards: 0, instances: [], shown: 0 }, parts: ['card count', 'a card fully shown'], says: [/\[FAIL\] card count: 0 \(needs at least 1\)/, /\[FAIL\] a card fully shown: no cards/] },
    { snap: { instances: ['busy', 'b'] }, parts: ['card instances'], says: [/\[FAIL\] card instances: \["busy","b"\] \(needs only "busy"\)/] },
    { snap: { instances: [''] }, parts: ['card instances'], says: [/\[FAIL\] card instances: \[""\]/] },
    { snap: { shown: 0, notShown: ['opacity 0.4 on main', 'outside the viewport (box 300x80 at 10,950, viewport 1280x900)'] }, parts: ['a card fully shown'], says: [/\[FAIL\] a card fully shown: 0 of 3, not shown: opacity 0\.4 on main \/ outside the viewport \(box 300x80 at 10,950, viewport 1280x900\)/] },
    { snap: { current: ['b'] }, parts: ['aria-current row'], says: [/\[FAIL\] aria-current row: \["b"\] \(needs only "busy"\)/] },
    { snap: { current: [] }, parts: ['aria-current row'], says: [/\[FAIL\] aria-current row: \[\]/] },
    { snap: { current: ['busy', 'b'] }, parts: ['aria-current row'], says: [/\[FAIL\] aria-current row: \["busy","b"\]/] },
  ];
  for (const c of cases) {
    const msg = explainBoard("busy's Board after its fresh answer, instance switch 4 of 5 (i = 3)", 'busy', { ok: false, snap: { ...SHOWN, ...c.snap } });
    assert.deepEqual(failedParts(msg), c.parts, msg);
    for (const re of c.says) assert.match(msg, re);
    for (const part of ['card count', 'card instances', 'a card fully shown', 'aria-current row'].filter((p) => !c.parts.includes(p))) {
      assert.match(msg, new RegExp(`\\[ok\\] ${part}: `), `${part} holds: ${msg}`);
    }
    // The failure output's own words stay first (searches of old CI logs keep matching), and the switch is named.
    assert.ok(msg.startsWith("busy's Board after its fresh answer, instance switch 4 of 5 (i = 3): failed: "), msg);
    // One line: the relay's test prints it as one diagnostic, and a TAP reporter takes one line per diagnostic.
    assert.ok(!msg.includes('\n'), msg);
  }
});

test('#639 the report says what bears on the check: a board-instance-error, "updating…", the page', () => {
  const msg = explainBoard('the Board after its fresh answer', 'busy', { ok: false, snap: { ...SHOWN, cards: 0, instances: [], shown: 0, errors: ["busy: can't load its board: 502"], updating: true, path: '/', board: true } });
  assert.match(msg, /board-instance-error: "busy: can't load its board: 502"/);
  assert.match(msg, /"updating…" shown: yes/);
  assert.match(msg, /page \/, the Board in it/);
  const quiet = explainBoard('x', 'busy', { ok: false, snap: { ...SHOWN, shown: 0, path: '/prs', board: false } });
  assert.match(quiet, /board-instance-error: none/);
  assert.match(quiet, /"updating…" shown: no/);
  assert.match(quiet, /page \/prs, no Board in it/);
});

test('#639 a false check whose parts all hold says the two disagree, never a silent "failed:" with nothing named', () => {
  const msg = explainBoard('x', 'busy', { ok: false, snap: SHOWN });
  assert.match(msg, /^x: failed, though every part holds in this snapshot \(the check and this report disagree\);/);
  assert.match(explainBoard('x', 'busy', { ok: true, snap: SHOWN }), /^x: passed;/);
});

// ---- the in-page parts, against a fake page ----

type Anim = { animationName: string; playState: string; currentTime: number; effect: { getComputedTiming: () => { iterations: number } } };
type El = {
  tagName: string;
  dataset: Record<string, string>;
  isConnected: boolean;
  attrs: string[];
  parentElement: El | null;
  rect: { left: number; top: number; width: number; height: number };
  style: { display: string; visibility: string; opacity: string };
  anims: Anim[];
  textContent: string;
  closest: (sel: string) => El | null;
  hasAttribute: (a: string) => boolean;
  getBoundingClientRect: () => { left: number; top: number; width: number; height: number; right: number; bottom: number };
  getAnimations: () => Anim[];
};

function el(o: Partial<Omit<El, 'style'>> & { style?: Partial<El['style']> } = {}): El {
  const e: El = {
    tagName: 'DIV',
    dataset: {},
    isConnected: true,
    attrs: [],
    parentElement: null,
    rect: { left: 10, top: 10, width: 300, height: 80 },
    anims: [],
    textContent: '',
    ...o,
    style: { display: 'block', visibility: 'visible', opacity: '1', ...o.style },
    closest(sel) {
      assert.equal(sel, '[hidden],[inert]');
      for (let x: El | null = e; x; x = x.parentElement) if (x.attrs.includes('hidden') || x.attrs.includes('inert')) return x;
      return null;
    },
    hasAttribute: (a) => e.attrs.includes(a),
    getBoundingClientRect: () => ({ ...e.rect, right: e.rect.left + e.rect.width, bottom: e.rect.top + e.rect.height }),
    getAnimations: () => e.anims,
  };
  return e;
}
const anim = (animationName: string, playState: string, iterations = 1): Anim => ({ animationName, playState, currentTime: 40.4, effect: { getComputedTiming: () => ({ iterations }) } });
const page = (globals: Record<string, unknown>) => ({ innerWidth: 1280, innerHeight: 900, getComputedStyle: (e: El) => e.style, ...globals });
const why = (target: El | null): string => runInNewContext(`${NOT_SHOWN_WHY}(target)`, page({ target })) as string;

test("#639 NOT_SHOWN_WHY: '' for a card fully shown, else the check's own reason", () => {
  const main = el({ tagName: 'MAIN' });
  const board = el({ dataset: { testid: 'page-board' }, parentElement: main });
  const card = (o: Parameters<typeof el>[0] = {}) => el({ tagName: 'ARTICLE', dataset: { testid: 'board-card' }, parentElement: board, ...o });
  assert.equal(why(card()), '');
  // A finished fade, and a spinner that loops, don't count against it.
  assert.equal(why(card({ anims: [anim('fade-in', 'finished'), anim('spin', 'running', Infinity)] })), '');

  assert.equal(why(null), 'not in the page');
  assert.equal(why(card({ isConnected: false })), 'not in the page');
  board.attrs = ['hidden'];
  assert.equal(why(card()), 'inside hidden div[data-testid=page-board]');
  board.attrs = ['inert'];
  assert.equal(why(card()), 'inside inert div[data-testid=page-board]');
  board.attrs = [];
  assert.equal(why(card({ rect: { left: 10, top: 10, width: 0, height: 80 } })), 'an empty box 0x80 at 10,10');
  assert.equal(why(card({ rect: { left: 10, top: 950, width: 300, height: 80 } })), 'outside the viewport (box 300x80 at 10,950, viewport 1280x900)');
  assert.equal(why(card({ rect: { left: 10, top: -100, width: 300, height: 80 } })), 'outside the viewport (box 300x80 at 10,-100, viewport 1280x900)');
  main.style.display = 'none';
  assert.equal(why(card()), 'display:none on main');
  main.style.display = 'block';
  assert.equal(why(card({ style: { visibility: 'hidden' } })), 'visibility:hidden on article[data-testid=board-card]');
  board.style.opacity = '0.4';
  assert.equal(why(card()), 'opacity 0.4 on div[data-testid=page-board]');
  board.style.opacity = '0.995';
  assert.equal(why(card()), '');
  assert.equal(why(card({ anims: [anim('fade-in', 'running')] })), 'entrance animation fade-in running at 40 ms');
});

test('#639 BOARD_SNAPSHOT reads each part of the check from the page in one go', () => {
  const board = el({ dataset: { testid: 'page-board' } });
  const shown = el({ tagName: 'ARTICLE', dataset: { testid: 'board-card', cardInstance: 'busy' }, parentElement: board });
  const faded = el({ tagName: 'ARTICLE', dataset: { testid: 'board-card', cardInstance: 'b' }, parentElement: board, style: { opacity: '0.4' } });
  const bare = el({ tagName: 'ARTICLE', dataset: { testid: 'board-card' }, parentElement: board, rect: { left: 0, top: 0, width: 0, height: 0 } });
  const all: Record<string, El[]> = {
    [BOARD_CARDS]: [shown, faded, bare],
    [CURRENT_ROWS]: [el({ textContent: '  b \n' })],
    '[data-testid="board-instance-error"]': [el({ textContent: " busy: can't load its board " })],
  };
  const one: Record<string, El | null> = { '[data-testid="page-board"]': board, '[data-testid="updating"]': el() };
  const document = {
    querySelectorAll: (sel: string) => all[sel] ?? assert.fail(`unexpected querySelectorAll(${sel})`),
    querySelector: (sel: string) => (sel in one ? one[sel] : assert.fail(`unexpected querySelector(${sel})`)),
  };
  // As Runtime.evaluate's returnByValue hands it over: plain JSON.
  const snap = JSON.parse(JSON.stringify(runInNewContext(BOARD_SNAPSHOT, page({ document, location: { pathname: '/' } })))) as BoardSnapshot;
  assert.deepEqual(snap, {
    path: '/',
    board: true,
    cards: 3,
    instances: ['busy', 'b', ''],
    shown: 1,
    notShown: ['opacity 0.4 on article[data-testid=board-card]', 'an empty box 0x0 at 0,0'],
    current: ['b'],
    errors: ["busy: can't load its board"],
    updating: true,
  });
  one['[data-testid="updating"]'] = null;
  one['[data-testid="page-board"]'] = null;
  all[BOARD_CARDS] = [];
  const none = JSON.parse(JSON.stringify(runInNewContext(BOARD_SNAPSHOT, page({ document, location: { pathname: '/prs' } })))) as BoardSnapshot;
  assert.deepEqual({ ...none, current: [], errors: [] }, { path: '/prs', board: false, cards: 0, instances: [], shown: 0, notShown: [], current: [], errors: [], updating: false });
});
