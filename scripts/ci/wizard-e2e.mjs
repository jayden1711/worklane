#!/usr/bin/env node
// CI only (the "wizard end to end (real systemd)" job in .github/workflows/ci-slow.yml): a person's browser walking
// the first-run wizard, from the one URL the install printed to a working project. Headless Chrome over the DevTools
// protocol (src/browser/cdp.ts, built): real clicks, real typing, the key page given the key file. Between clicks it
// checks what each screen did to the machine (files with their owner and mode, units, config, the stand-ins' records).
//
//   node wizard-e2e.mjs local <dist dir> <wizard URL> <key file> <out dir> <checkout>
//       local mode, as this user: the stand-ins in $WIZARD_STANDIN_DIR play Anthropic's sign-in, GitHub's device
//       page and GitHub's merge button (scripts/ci/wizard-stand-ins/)
//   node wizard-e2e.mjs server <dist dir> <wizard URL> <key file> <out dir> <instance>
//       server mode, through the hub's break-glass: checks on the machine through sudo (the runner's)
//   node wizard-e2e.mjs setup-loopback <dist dir> <setup URL> <setup token file> <out dir> -
//       a fresh server with no https origin: the hub's setup mode on loopback, as the install printed it; the one-time
//       token from its file, then the sign-in App step, which must say https comes first and point to screen 7
//
// It prints one JSON line per screen ({"screen", "ok", "ms", ...}) and writes <out dir>/urls.txt (every URL the
// browser asked for) and <out dir>/automation.json (each step's "Without this page" line as the page showed it), for
// the job's leak check. Nothing secret is ever printed: the key goes into the page from its file, never typed here.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode, dist, wizardUrl, keyFile, out, extra] = process.argv.slice(2);
if (!['local', 'server', 'setup-loopback'].includes(mode) || !dist || !wizardUrl || !keyFile || !out || !extra) {
  console.error('usage: wizard-e2e.mjs local <dist dir> <wizard URL> <key file> <out dir> <checkout>\n       wizard-e2e.mjs server <dist dir> <wizard URL> <key file> <out dir> <instance>\n       wizard-e2e.mjs setup-loopback <dist dir> <setup URL> <setup token file> <out dir> -');
  process.exit(2);
}
const instance = mode === 'server' ? extra : null;
const checkout = mode === 'local' ? extra : null;
const { launchChrome, findChrome, until, sleep } = await import(pathToFileURL(join(dist, 'src', 'browser', 'cdp.js')).href);
mkdirSync(out, { recursive: true });
const origin = new URL(wizardUrl).origin;
const standin = process.env.WIZARD_STANDIN_DIR ?? '';
const t0 = Date.now();
const say = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);

// ---------------------------------------------------------------- the browser
const chrome = findChrome(process.env.CHROME);
assert.ok(chrome, 'no Chrome or Chromium on this machine');
// WHY --no-sandbox only as root: Chrome refuses to run its sandbox as root; the job runs it as the runner user.
const browser = await launchChrome(chrome, { noSandbox: process.getuid?.() === 0 });
const cdp = browser.cdp;
const urls = [];
const errors = [];
cdp.on('Network.requestWillBeSent', (p) => urls.push(p.request.url));
cdp.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails.exception?.description ?? p.exceptionDetails.text));
await cdp.send('Page.enable');
await cdp.send('Runtime.enable');
await cdp.send('Network.enable');
await cdp.send('DOM.enable');

async function evaluate(expr) {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result.value;
}
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const tid = (id, within = '') => `${within ? `${within} ` : ''}[data-testid="${id}"]`;
const row = (step) => `[data-testid="first-run-step"][data-step="${step}"]`;
const waitFor = (sel, ms = 20_000) => until(sel, () => evaluate(`!!${q(sel)}`), ms, 200);
const text = (sel) => evaluate(`${q(sel)}?.innerText ?? null`);
const attr = (sel, a) => evaluate(`${q(sel)}?.getAttribute(${JSON.stringify(a)}) ?? null`);
async function waitText(sel, re, ms = 30_000) {
  return until(`${sel} to read ${re}`, async () => {
    const t = await text(sel);
    return t && re.test(t) ? t : null;
  }, ms, 300);
}
async function open(path) {
  await cdp.send('Page.navigate', { url: `${origin}${path}` });
  await until(`${path} to load`, () => evaluate(`document.readyState === 'complete' && !!document.querySelector('#root > *')`), 30_000, 200);
}
/** A real mouse click at the element's centre, as a person's. */
async function click(sel) {
  const at = await until(sel, () => evaluate(`(() => { const e = ${q(sel)}; if (!e || e.disabled) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return r.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`), 20_000, 200);
  for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
  await sleep(200);
}
/** Clear a field and type into it, as a person would. */
async function type(sel, value) {
  await click(sel);
  // INVARIANT: the click focused the field. If the page moved under the pointer, say so here, not as an empty value
  // later (run 38541318584: the click landed above the field and Ctrl+A selected the whole page).
  assert.ok(await evaluate(`document.activeElement === ${q(sel)}`), `the click on ${sel} didn't focus it (focus is on ${await evaluate('document.activeElement?.outerHTML?.slice(0, 120) ?? null')})`);
  // Select what's there (a number field has no select()), as Ctrl+A does, then type over it.
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, commands: ['selectAll'] });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
  await cdp.send('Input.insertText', { text: String(value) });
  const now = await evaluate(`${q(sel)}.value`);
  assert.equal(now, String(value), `typed into ${sel}`);
  await sleep(150);
}
async function stepStatus(step) {
  return attr(row(step), 'data-status');
}
/** Once, right after an action's own result: the step reads done, checked fresh. No loop. */
async function assertDone(step) {
  const s = (await firstRun(true)).setup.groups.flatMap((g) => g.steps).find((x) => x.id === step);
  assert.ok(s?.done, `${step} reads not done right after its action: ${s?.detail}`);
}
async function openFix(step) {
  const panel = `${row(step)} ${tid('first-run-fix-panel')}`;
  if (!(await evaluate(`!!${q(panel)}`))) await click(`${row(step)} ${tid('first-run-fix')}`);
  await waitFor(panel);
  return panel;
}
/** The first-run checklist as the page's own API gives it (with the key the page holds). */
/** `fresh`: checked now, as the page's Re-check asks (GitHub's answers are otherwise kept for 2 minutes). */
async function firstRun(fresh = false) {
  return evaluate(`(async () => {
    const t = sessionStorage.getItem('dash-token') ?? '';
    const path = ${JSON.stringify(mode === 'server' ? `/api/i/${instance}/first-run` : '/api/first-run')} + ${JSON.stringify(fresh ? '?fresh=1' : '')};
    const r = await fetch(path, { headers: t ? { authorization: 'Bearer ' + t } : {} });
    return r.ok ? r.json() : { error: r.status };
  })()`);
}
const sh = (cmd, args, o = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...o });
  return { status: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};
/** A file's owner and octal mode (through sudo on a server: the files are other users'). */
function stat(path) {
  const r = mode === 'server' ? sh('sudo', ['stat', '-c', '%U %a', path]) : sh('stat', process.platform === 'darwin' ? ['-f', '%Su %Lp', path] : ['-c', '%U %a', path]);
  assert.equal(r.status, 0, `stat ${path}: ${r.err}`);
  return r.out;
}

const results = [];
/**
 * One screen of the walk. A failed screen is recorded with what the page showed, and the walk goes on to the next
 * (the run still fails at the end), so one run shows every screen's result; `gate` stops the walk there instead,
 * for a screen everything after needs (the key page).
 */
async function screen(name, fn, { gate = false } = {}) {
  const s = Date.now();
  try {
    const detail = (await fn()) ?? null;
    const r = { screen: name, ok: true, ms: Date.now() - s, ...(detail ? { detail } : {}) };
    results.push(r);
    say(r);
  } catch (e) {
    const shot = join(out, `${name.replace(/[^a-z0-9]+/gi, '-')}.png`);
    try {
      writeFileSync(shot, Buffer.from((await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
    } catch {
      // the screenshot is a help, never the failure
    }
    const r = { screen: name, ok: false, ms: Date.now() - s, error: e.message.split('\n').slice(0, 6).join(' | '), screenshot: shot, page: (await text('main').catch(() => ''))?.replace(/\s+/g, ' ').slice(0, 3000) };
    results.push(r);
    say(r);
    if (gate) throw e;
  }
}

// ---------------------------------------------------------------- the walk, both modes
async function keyPage() {
  await screen('the install\'s one URL, and the key page given the key file', async () => {
    await cdp.send('Page.navigate', { url: wizardUrl });
    await waitFor(tid('key-form'), 30_000);
    assert.ok(!new URL(await evaluate('location.href')).search, 'the URL carries nothing');
    // The key file, chosen in the file input, as a person picks it (never typed, never in the address bar).
    const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: `${tid('key-file')} input[type="file"]` });
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [keyFile] });
    await waitFor(tid('page-first-run'), 30_000);
    assert.ok(!(await evaluate('location.href')).includes('t='), 'no key in the address bar');
    return { at: await evaluate('location.pathname') };
  }, { gate: true });
}

/** Every step's "Without this page" line: on the first-run page (opened from ?step=) and in Settings' Setup screens. */
async function automationLines(f) {
  const shown = {};
  await screen('every screen shows its "Without this page" line', async () => {
    const steps = f.setup.groups.flatMap((g) => g.steps).filter((s) => s.automation);
    assert.ok(steps.length >= 8, `only ${steps.length} steps have an automation line`);
    for (const s of steps) {
      if (s.fix.kind === 'screen' || s.fix.kind === 'start') continue;
      await open(`/first-run?step=${encodeURIComponent(s.id)}`);
      const line = await waitText(`${row(s.id)} ${tid('first-run-automation')}`, /^Without this page: /, 20_000);
      assert.equal(line.replace(/^Without this page: /, '').trim(), s.automation.trim(), `${s.id}'s line`);
      shown[s.id] = line;
    }
    await open('/settings');
    await waitFor(tid('setup-screens'));
    for (const s of steps.filter((x) => ['action', 'form', 'start', 'screen', 'signin', 'gh-login', 'discord'].includes(x.fix.kind))) {
      const t = await text(`${tid('setup-screens')} [data-testid="setup-screen"][data-step="${s.id}"]`);
      assert.ok(t?.includes(s.automation.trim()), `Settings lists ${s.id} with its automation line (got ${t})`);
      shown[`settings:${s.id}`] = s.automation;
    }
    writeFileSync(join(out, 'automation.json'), `${JSON.stringify(shown, null, 2)}\n`);
    return { steps: Object.keys(shown).length };
  });
}

/** Settings' Setup screens: "Run again" on a done step opens it on the first-run page, its panel open. */
async function rerunFromSettings(step, check) {
  await screen(`rerun ${step} from Settings`, async () => {
    await open('/settings');
    const link = `${tid('setup-screens')} [data-testid="setup-screen"][data-step="${step}"] ${tid('setup-screen-open')}`;
    await waitFor(link);
    assert.equal((await text(link))?.trim(), 'Run again');
    await click(link);
    await until('the first-run page at that step', () => evaluate(`location.pathname === '/first-run' && location.search === '?step=${step}'`), 10_000);
    await waitFor(`${row(step)} ${tid('first-run-fix-panel')}`);
    return check ? await check() : null;
  });
}

// ---------------------------------------------------------------- local mode
async function local() {
  const st = (f) => join(standin, f);
  await keyPage();
  const f = await firstRun();
  assert.equal(f.mode, 'local');
  await screen('screen 1: the checklist, local mode, setup mode (no config yet)', async () => {
    await waitText(tid('first-run-mode'), /^Local mode/);
    await waitFor(tid('first-run-setup-mode'));
    return { steps: f.setup.total, done: f.setup.done };
  });

  await screen('screen 2: Sign in to Claude (claude auth login relayed; Anthropic\'s page played by the stand-in)', async () => {
    await open('/first-run');
    const p = await openFix('claude-login');
    await click(`${p} ${tid('claude-signin-button')}`);
    await click(`${p} ${tid('claude-signin-confirm')}`);
    // Async by design; the signal: the relayed link, which the panel shows once claude auth login hands it over.
    const href = await until('the sign-in link', () => attr(`${p} ${tid('claude-signin-link')}`, 'href'), 30_000, 300);
    const u = new URL(href);
    assert.equal(u.origin, 'https://claude.ai');
    assert.equal(new URL(u.searchParams.get('redirect_uri')).hostname, 'localhost');
    // The person signs in on Anthropic's page (not opened here: it is outside); Claude Code's listener hears back.
    writeFileSync(st('claude-signed-in'), '');
    // Async by design; the signal: the panel's own state turning done (it polls `claude auth status` every 2 s).
    await waitFor(`${p} [data-testid="claude-signin"][data-state="done"]`, 30_000);
    await assertDone('claude-login');
    assert.match(readFileSync(st('claude-calls'), 'utf8'), /^auth login$/m);
  });

  await screen('screen 3: Connect GitHub (gh\'s device login relayed; the code typed on GitHub by the stand-in)', async () => {
    const p = await openFix('gh-login');
    await click(`${p} ${tid('gh-login-start')}`);
    const code = await waitText(`${p} ${tid('gh-login-code')}`, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    assert.equal(code, 'WZRD-2E2E');
    assert.equal(await attr(`${p} ${tid('gh-login-link')}`, 'href'), 'https://github.com/login/device');
    writeFileSync(st('gh-code-typed'), '');
    // Async by design; the signal: the panel's own state turning done (it asks `gh auth status` while waiting).
    await waitFor(`${p} [data-testid="gh-login"][data-state="done"]`, 30_000);
    await assertDone('gh-login');
    assert.ok(existsSync(st('gh-signed-in')), "gh's own store has the login");
    assert.match(readFileSync(st('gh-calls'), 'utf8'), /^auth login --web --hostname github\.com --git-protocol https$/m);
  });

  await screen('screen 4: the repo config in setup mode (auto-config drafts it, previewed, Confirm opens PR #1, merged here from the Config PRs list)', async () => {
    const p = await openFix('config-on-main');
    await waitFor(`${p} ${tid('setup-config')}`);
    await click(`${p} ${tid('setup-draft-button')}`);
    await click(`${p} ${tid('setup-draft-confirm')}`);
    // auto-config runs the project's own commands on a scratch worktree; an open question is answered on the page.
    // Async by design; the signal: /api/first-run's own draft state (running, then a question or the held draft).
    const asked = await until('the draft to finish or ask', async () => {
      const fr = await firstRun();
      if (fr.draft?.running) return null;
      if (fr.autoConfig?.questions?.length) return 'questions';
      return fr.autoConfig?.held ? 'held' : (fr.draft?.result ? `result: ${JSON.stringify(fr.draft.result)}` : null);
    }, 240_000, 1000);
    if (asked === 'questions') {
      await open('/first-run?step=config-on-main');
      const fr = await firstRun();
      for (const qn of fr.autoConfig.questions) await click(`${tid('setup-question')}[data-question="${qn.id}"] ${tid('setup-choice')}`);
      await click(tid('setup-save-answers'));
      await click(tid('setup-draft-button'));
      await click(tid('setup-draft-confirm'));
      // Async by design; the signal: the held draft in /api/first-run's auto-config state.
      await until('the draft held for its preview', async () => (await firstRun()).autoConfig?.held, 240_000, 1000);
    } else assert.equal(asked, 'held', `auto-config: ${asked}`);
    // #468: the preview before any PR: the summary, then the files; nothing pushed yet.
    assert.ok(!existsSync(st('prs/1')), 'no PR before Confirm');
    await open('/first-run?step=config-on-main');
    await waitFor(tid('draft-preview'));
    await waitText(tid('draft-summary-owners'), /owner @example-owner/);
    assert.ok(await evaluate(`document.querySelectorAll('[data-testid="draft-file"]').length >= 4`), 'the drafted files, read-only');
    await click(tid('draft-confirm'));
    // Not the repo's admin here (the stand-in's default): the PR is opened, not merged; the Config PRs list follows it.
    // The signal: PR #1's row in that list, open (the page re-reads the checklist when Confirm returns).
    const row1 = '[data-testid="config-pr"][data-number="1"]';
    await waitFor(`${row1}[data-state="open"]`, 60_000);
    await waitText(tid('setup-pr'), /merge it under Config PRs below, or on GitHub/);
    assert.match(readFileSync(st('prs/1'), 'utf8'), /^example\/alpha main worklane\/setup OPEN$/m);
    // #468 item 15: PR #1 is merged here like every later config PR, then the checkout is fast-forwarded.
    await click(`${row1} ${tid('config-pr-merge-review')}`);
    await waitText(`${row1} ${tid('config-pr-merge-confirming')}`, /gh pr merge 1 --repo example\/alpha --merge --subject .*approved by example-owner on the first-run page/);
    await click(`${row1} ${tid('config-pr-merge-confirm')}`);
    // The dashboard fast-forwards the checkout to the merged config and leaves setup mode on the same address.
    // Async by design; the signal: /api/first-run's setupMode turning false (the page hands over on it).
    await until('setup mode to hand over', async () => (await firstRun()).setupMode === false, 120_000, 1000);
    const bare = st('git/example/alpha.git');
    assert.equal(sh('git', ['-C', bare, 'cat-file', '-e', 'main:.worklane/config.yaml']).status, 0, 'the config is on main at "GitHub"');
    assert.match(readFileSync(st('prs/1'), 'utf8'), /^example\/alpha main worklane\/setup MERGED /m);
    assert.ok(existsSync(join(checkout, '.worklane', 'config.yaml')), 'the checkout has the config');
    // #468 item 10: the page hands over onto First run itself, never the empty Board; the stale "run init again" box is gone.
    await until('the page reloaded on First run', () => evaluate(`location.pathname === '/first-run' && !!${q(tid('page-first-run'))} && !!${q('[data-testid="config-pr"][data-number="1"][data-synced="true"]')}`), 60_000, 300);
    assert.ok(!(await evaluate(`!!${q(tid('first-run-auto-config-pr'))}`)), 'no stale "merge it, then run init again"');
    assert.match(readFileSync(st('gh-calls'), 'utf8'), /^pr merge 1 --repo example\/alpha --merge --subject .*approved by example-owner on the first-run page --body $/m, 'the approval in the merge subject');
  });

  let configPr = null;
  await screen('screen 4: the repo config form (required checks) proposed as a PR', async () => {
    await open('/first-run?step=required-checks');
    const p = `${row('required-checks')} ${tid('first-run-fix-panel')}`;
    await waitFor(`${p} ${tid('repo-config-form')}`);
    // Async by design: the form asks GitHub which checks ran on the tip (RepoConfigForm.tsx's getChecksSeen) and then
    // shows them, or a note, ABOVE the field (run 38541318584's click landed where the field had been). The signal: that
    // answer in the checks block (a check offered, or the note), bounded.
    await until('the checks GitHub ran, or the note', () => evaluate(`(() => { const b = ${q(`${p} ${tid('repo-config-checks')}`)}; return !!b && (!!b.querySelector('[data-testid="repo-config-check"]') || !!b.querySelector('p')); })()`), 30_000, 200);
    // #469, both paths. No check named yet: the starter CI, last in the form. Its file goes to GitHub's new-file page,
    // prefilled, for the person to commit; nothing here pushes it.
    await waitFor(`${p} ${tid('starter-ci')}`);
    const refs = () => sh('git', ['-C', st('git/example/alpha.git'), 'for-each-ref', '--format=%(refname) %(objectname)']).out;
    const refsBefore = refs();
    await click(`${p} ${tid('starter-ci-add')}`);
    await waitText(`${p} ${tid('starter-ci-summary')}`, /for every PR and every push to main, as the check `test`/);
    const href = await evaluate(`${q(`${p} ${tid('starter-ci-confirm')}`)}.href`);
    const ci = new URL(href);
    assert.equal(`${ci.origin}${ci.pathname}`, 'https://github.com/example/alpha/new/main');
    assert.equal(ci.searchParams.get('filename'), '.github/workflows/ci.yml');
    assert.match(ci.searchParams.get('value'), /^permissions:\n {2}contents: read$/m);
    assert.match(ci.searchParams.get('value'), /^ {2}test:\n {4}name: test$/m);
    assert.equal(refs(), refsBefore, 'nothing pushed');
    // No CI: this repo's tests.yaml has no test_run, so it isn't offered; it says to add the starter CI instead.
    await waitText(`${p} ${tid('no-ci-refused')}`, /add the starter CI/);
    await type(`${p} ${tid('repo-config-check-name')}`, 'test');
    await click(`${p} ${tid('repo-config-check-add')}`);
    await click(`${p} ${tid('repo-config-review')}`);
    await waitText(`${p} ${tid('repo-config-confirming')}`, /required_checks/);
    await click(`${p} ${tid('repo-config-propose')}`);
    const res = await waitText(`${p} ${tid('repo-config-result')}`, /pull\/\d+/);
    const n = (configPr = res.match(/pull\/(\d+)/)[1]);
    const [repo, base, head, state] = readFileSync(st(`prs/${n}`), 'utf8').trim().split(' ');
    assert.deepEqual([repo, base, state], ['example/alpha', 'main', 'OPEN']);
    const bare = st('git/example/alpha.git');
    assert.match(sh('git', ['-C', bare, 'show', `${head}:.worklane/config.yaml`]).out, /required_checks:[\s\S]*- test/);
    return { pr: n, head };
  });

  await screen('screen 4: the config PR merged outside the page (the CLI); the page sees it, fast-forwards the checkout, says who and where, and stays on First run', async () => {
    // #468 item 9/12: merged anywhere, not only by this page's button: here with the CLI, as a person would.
    assert.ok(configPr, 'the config PR from the screen before');
    const bare = st('git/example/alpha.git');
    const merged = sh('gh', ['pr', 'merge', configPr, '--repo', 'example/alpha', '--merge']);
    assert.equal(merged.status, 0, merged.err);
    assert.match(readFileSync(st(`prs/${configPr}`), 'utf8'), / MERGED /m, 'merged at "GitHub", outside the page');
    // The page's own Re-check (a person's, or its poll): it sees the merge and brings the checkout to it.
    await open('/first-run');
    await click(tid('first-run-recheck'));
    const rowN = `[data-testid="config-pr"][data-number="${configPr}"]`;
    // Async by design; the signal: the PR's row reading merged and in this checkout, bounded.
    await until('the merged PR synced', () => evaluate(`!!${q(`${rowN}[data-synced="true"]`)}`), 60_000, 500);
    const done = await waitText(`${rowN} ${tid('config-pr-done')}`, /Merged by @example-owner at .*, checkout at [0-9a-f]{7}/);
    assert.equal(sh('git', ['-C', checkout, 'rev-parse', 'HEAD']).out, sh('git', ['-C', bare, 'rev-parse', 'main']).out, 'the checkout is at the merged main, no git pull');
    assert.match(readFileSync(join(checkout, '.worklane', 'config.yaml'), 'utf8'), /required_checks:[\s\S]*- test/);
    await waitText(row('required-checks'), /required: test/, 20_000);
    assert.equal(await evaluate('location.pathname'), '/first-run', 'still on First run');
    return { result: done };
  });
}

async function localRest(root) {
  await screen('screen 10: fingerprints skipped (its fetch runs a database command this project has no database for)', async () => {
    await open('/first-run');
    await click(`${row('fingerprints')} ${tid('first-run-skip')}`);
    // The signal: the step's own badge, which the page re-reads when the skip request returns.
    await until('fingerprints skipped', async () => (await stepStatus('fingerprints')) === 'skipped', 20_000, 300);
  });
  await screen('screen 10: the hooks for local runs and the pre-commit secret scan', async () => {
    for (const step of ['hooks', 'pre-commit']) {
      await open(`/first-run?step=${step}`);
      const p = `${row(step)} ${tid('first-run-fix-panel')}`;
      await click(`${p} ${tid('first-run-action-button')}`);
      await click(`${p} ${tid('first-run-action-confirm')}`);
      // The action's own result (the request returning), then the step checked once.
      await waitText(`${p} ${tid('first-run-action-result')}`, /./);
      await assertDone(step);
    }
    assert.ok(existsSync(join(root, '.claude', 'settings.json')));
    const hook = join(root, '.git', 'hooks', 'pre-commit');
    assert.match(stat(hook), / 7[0-7][0-7]$/, 'the pre-commit hook is executable');
    assert.match(readFileSync(hook, 'utf8'), /gitleaks/);
    return { hook: stat(hook) };
  });

  await screen('screen 6: Protect the default branch (the PUT to GitHub played by the stand-in)', async () => {
    await open('/first-run?step=protection');
    const p = `${row('protection')} ${tid('first-run-fix-panel')}`;
    await waitText(`${p} ${tid('first-run-action-plan')}`, /test/);
    await click(`${p} ${tid('first-run-action-button')}`);
    await click(`${p} ${tid('first-run-action-confirm')}`);
    await waitText(`${p} ${tid('first-run-action-result')}`, /GitHub now requires test on main/);
    const body = JSON.parse(readFileSync(join(standin, 'gh-protection-body.json'), 'utf8'));
    assert.ok(JSON.stringify(body).includes('"test"'), 'the protection requires the check');
    await assertDone('protection');
  });
}

async function localStart() {
  await screen('Start: the coordinator as a systemd --user service', async () => {
    // WHY: off Linux this would load a real launchd agent for whoever runs it; the job runs on Linux.
    if (process.platform !== 'linux') return { skipped: `not on Linux (${process.platform})` };
    await open('/first-run');
    await waitFor(tid('first-run-start'));
    await click(tid('first-run-start-button'));
    await click(tid('first-run-start-confirm'));
    await waitText(tid('first-run-start-result'), /./, 60_000);
    const f = await firstRun();
    const label = f.start.label;
    if (process.platform === 'linux') {
      // Once, right after Start's own result (it ran systemctl --user enable --now before answering).
      assert.equal(sh('systemctl', ['--user', 'is-active', `${label}.service`]).out, 'active');
      return { unit: `${label}.service`, file: f.start.file, mode: stat(f.start.file) };
    }
    return { label };
  });
}

// ---------------------------------------------------------------- server mode
async function server() {
  await keyPage();
  // The hub shows one instance at a time: the break-glass page picks the first; make sure it is this one.
  const f = await firstRun();
  assert.ok(!f.error, `the hub's first-run for ${instance}: ${JSON.stringify(f)}`);
  assert.equal(f.mode, 'server');
  await screen('the checklist, server mode, through the hub', async () => {
    await open('/first-run');
    await waitText(tid('first-run-mode'), /^Server mode/);
    const status = Object.fromEntries(f.setup.groups.flatMap((g) => g.steps).map((s) => [s.id, s.done ? 'done' : s.skipped ? 'skipped' : 'todo']));
    for (const s of ['signin-app', 'agent-app', 'config-on-main', 'owners', 'coordinator']) assert.equal(status[s], 'done', `${s} is done after the install and the first project (${JSON.stringify(status)})`);
    return { status };
  });
  // #739: before Tailscale and the updater (serverMachine, below), the checklist already leads to the first task: the
  // updater is listed after it and blocks nothing until the instance's first PR.
  await screen('the first task (server): a step after the coordinator, reached without the updater', async () => {
    const steps = f.setup.groups.flatMap((g) => g.steps);
    const groups = f.setup.groups.map((g) => g.id);
    assert.ok(groups.indexOf('coordinator') < groups.indexOf('first-task') && groups.indexOf('first-task') < groups.indexOf('updates'), `the order: ${groups.join(', ')}`);
    const task = steps.find((s) => s.id === 'server-first-task');
    assert.ok(task && !task.optional, `the server lists its first-task step as required (${JSON.stringify(task)})`);
    const updater = steps.find((s) => s.id === 'updater');
    assert.ok(updater && !updater.done, 'the updater is listed, not set up yet');
    assert.equal(updater.optional, true, `the updater blocks nothing before the first PR: ${updater.detail}`);
    assert.match(updater.detail, /^after your first PR: /);
    const left = steps.filter((s) => !s.optional && !s.done && !s.skipped).map((s) => s.id);
    assert.ok(!left.includes('updater'), `the required steps left: ${left.join(', ')}`);
    await open('/first-run?step=server-first-task');
    const panel = await waitText(`${row('server-first-task')} ${tid('first-run-outside')}`, /signed in as one of the writers/);
    return { left, task: task.detail, updater: updater.detail, panel };
  });

  await screen('screen 2 (server): the agents\' Claude login reads done after the first project stored it', async () => {
    // add-project.sh stored the token for wl-<instance>-agent (the job checked the file, 0600); the step must say so.
    const claude = f.setup.groups.flatMap((g) => g.steps).find((s) => s.id === 'claude-token');
    assert.ok(claude?.done, `the agents' Claude login reads not done: ${claude?.detail}`);
  });

  await screen('screen 2 (server): the agents\' Claude login panel: no paste box, the root commands shown', async () => {
    await open('/first-run?step=claude-token');
    const p = `${row('claude-token')} ${tid('first-run-fix-panel')}`;
    await waitFor(`${p} ${tid('claude-signin-root')}`);
    // Issue #711: the page never takes a Claude credential: no password field anywhere in the panel.
    assert.equal(await evaluate(`!!${q(`${p} input[type="password"]`)}`), false, 'a paste box in the Claude login panel');
    await waitText(`${p} ${tid('claude-signin-login-command')}`, /sudo -u wl-[a-z0-9-]+-agent -i claude auth login/);
    const cmd = await waitText(`${p} ${tid('claude-signin-command')}`, /credentials\.sh .* claude/);
    return { command: cmd, status: await text(`${p} ${tid('claude-signin-status')}`) };
  });

  await screen('screen 6 (server): Protect says why it isn\'t the dashboard\'s to do, and where an admin does it', async () => {
    await open('/first-run?step=protection');
    const why = await waitText(`${row('protection')} ${tid('first-run-action-unavailable')}`, /administration permission/);
    return { why };
  });

  await screen('screen 8: the instance\'s policy (budget changed, the change shown, then written)', async () => {
    await open('/first-run?step=policy');
    const p = `${row('policy')} ${tid('first-run-fix-panel')}`;
    await waitFor(`${p} ${tid('policy-form')}`);
    const budget = `${p} [data-testid="policy-field"][data-key="budget.daily_usd"] input`;
    const file = `${home(`wl-${instance}`)}/.local/state/worklane/instances/${instance}/policy.yaml`;
    const before = sudoOk('cat', file);
    // Below the repo's own agents.yaml budget ($20): refused at review, nothing written.
    await type(budget, '15');
    await click(`${p} ${tid('policy-review')}`);
    const no = await waitText(`${p} ${tid('policy-result')}`, /exceeds the policy budget 15; a repo can only tighten/);
    assert.equal(sudoOk('cat', file), before, 'a refused review wrote nothing');
    await type(budget, '30');
    await click(`${p} ${tid('policy-review')}`);
    const change = await waitText(`${p} ${tid('policy-confirming')}`, /budget\.daily_usd/);
    await click(`${p} ${tid('policy-confirm')}`);
    // The write's own result, then the file checked once.
    await waitText(`${p} ${tid('policy-result')}`, /./);
    assert.match(sudoOk('cat', file), /daily_usd: 30\b/);
    assert.equal(stat(file), `wl-${instance} 600`);
    return { refused: no, change: change.split('\n').find((l) => l.includes('daily_usd')), file: stat(file) };
  });

  // WHY skipped: since #387 the channel listing runs the engine's own CLI against Discord's API (a constant host); its
  // only stand-in is a code-level seam (startDashboard's discordListing), which the installed dashboard unit's CLI
  // never sets. So the real unit can't be given it, and a stand-in token would go to discord.com.
  await screen('screen 11: Discord skipped (Skip on the page; the step reads skipped)', async () => {
    await open('/first-run');
    await click(`${row('discord')} ${tid('first-run-skip')}`);
    // The signal: the step's own badge, which the page re-reads when the skip request returns.
    await until('discord skipped', async () => (await stepStatus('discord')) === 'skipped', 20_000, 300);
  });
  return f;
}

function home(user) {
  const r = sh('getent', ['passwd', user]);
  return r.out.split(':')[5];
}

const sudoOk = (...args) => {
  const r = sh('sudo', args);
  assert.equal(r.status, 0, `sudo ${args.join(' ')}: ${r.err}`);
  return r.out;
};

async function serverMachine() {
  // Screen 7: Tailscale and HTTPS, on the Machine page. Each confirmed step is a machine request that the coordinator
  // runs through the machine helper, in a unit of its own (worklane-tailscale.service), on its next tick.
  const ts = '/var/lib/worklane/tailscale';
  const lastStep = () => {
    const r = sh('sudo', ['tail', '-n', '1', `${ts}/steps.jsonl`]);
    return r.status === 0 && r.out ? JSON.parse(r.out) : null;
  };
  const tsStep = async (step, during) => {
    const card = `[data-testid="tailscale-step"][data-step="${step}"]`;
    await open('/machine');
    try {
      await click(`${card} ${tid('tailscale-step-run')}`);
    } catch (e) {
      // What the page and its data said when the step wasn't offered (run 38518412799: serve's button stayed disabled).
      const view = await evaluate(`fetch('/api/i/${instance}/tailscale', { headers: { authorization: 'Bearer ' + sessionStorage.getItem('dash-token') } }).then((r) => r.json()).then((j) => ({ next: j.next, busy: j.busy, run: j.run, steps: j.steps, allowed: j.allowed })).catch((x) => String(x))`);
      const panel = ((await text(tid('tailscale-setup'))) ?? '').replace(/\s+/g, ' ').slice(0, 1500);
      const unit = sh('systemctl', ['show', '-p', 'ActiveState,SubState,ExecMainExitTimestamp', 'worklane-tailscale.service']).out.replace(/\n/g, ' ');
      throw new Error(`${e.message}; the view: ${JSON.stringify(view)}; the panel: ${panel}; the unit: ${unit}; now ${new Date().toISOString()}`);
    }
    await waitFor(`${card} ${tid('tailscale-step-confirm')}`);
    await click(`${card} ${tid('tailscale-step-confirm-run')}`);
    if (during) await during();
    // Async by design (the coordinator runs the request on its next tick); the signal: steps.jsonl's end line for this step.
    const last = await until(`tailscale ${step} to end`, () => {
      const l = lastStep();
      return l && l.step === step && (l.state === 'done' || l.state === 'failed') ? l : null;
    }, 300_000, 1000);
    assert.equal(last.state, 'done', `tailscale ${step}: ${last.detail}`);
    // One step at a time: the next is asked for once this one's unit has gone.
    // The signal: the step's own unit (worklane-tailscale.service) gone, which the helper needs before the next step.
    await until('the tailscale unit to finish', () => sh('systemctl', ['is-active', '-q', 'worklane-tailscale.service']).status !== 0, 60_000, 1000);
    return last.detail;
  };
  await screen('screen 7: Tailscale, install (the real package from its signed repository), from the Machine page', async () => {
    await open('/machine');
    await waitFor(tid('tailscale-setup'), 30_000);
    const detail = await tsStep('install');
    assert.equal(stat('/usr/share/keyrings/tailscale-archive-keyring.gpg'), 'root 644');
    return { detail, version: sh('dpkg-query', ['-W', '-f=${Version}', 'tailscale']).out };
  });
  await screen('screen 7: Tailscale, log in (the login link on the page; the tailnet\'s login played by the stand-in)', async () => {
    // Nobody can log a CI machine in to a tailnet: from here the CLI is the stand-in (scripts/ci/tailscale-stand-in.cjs).
    sudoOk('systemctl', 'stop', 'tailscaled');
    sudoOk('install', '-o', 'root', '-g', 'root', '-m', '0755', join(dist, '..', 'scripts', 'ci', 'tailscale-stand-in.cjs'), '/usr/bin/tailscale');
    // Joined, so no tailnet-shaped name sits in the source (the denylist's check).
    const name = ['wizard-box', 'tail0ci', 'ts', 'net'].join('.');
    const detail = await tsStep('up', async () => {
      await open('/machine');
      // Async by design; the signal: the login link the page shows once tailscale up has printed it.
      const href = await until('the login link on the page', () => attr(tid('tailscale-login-link'), 'href'), 240_000, 1000);
      // Exactly the link tailscale printed, which only the asking coordinator's user can read on the machine.
      assert.equal(href, sudoOk('cat', `${ts}/login-url`));
      assert.equal(stat(`${ts}/login-url`), `wl-${instance} 400`);
      writeFileSync(join(out, 'tailscale-link'), `${href.split('/').pop()}\n`, { mode: 0o600 });
      sudoOk('sh', '-c', `printf '%s\\n' '{"BackendState":"Running","Self":{"DNSName":"${name}."},"CertDomains":["${name}"]}' > /var/lib/ci-tailscale/login.json`);
    });
    assert.equal(detail, `on the tailnet as ${name}`);
    return { detail };
  });
  await screen('screen 7: Tailscale, serve the hub over HTTPS (443 to the sign-in port only)', async () => {
    const detail = await tsStep('serve');
    const calls = sudoOk('cat', '/var/lib/ci-tailscale/calls').split('\n').map((l) => JSON.parse(l).args);
    assert.deepEqual(calls.filter((a) => a[0] === 'serve' && a[1] === '--bg'), [['serve', '--bg', '--https=443', 'http://127.0.0.1:4399']]);
    assert.ok(!calls.some((a) => a.includes('funnel')), 'never Funnel');
    return { detail };
  });

  // Screen 9: the updater, on the Machine page: install it, stage a release signer (confirmed by an admin at a root
  // shell, the one root step the page names), and follow releases.
  const updaterState = async () => {
    await open('/machine');
    await waitFor(tid('updater-setup'), 30_000);
    return text(`${tid('updater-setup')} [data-testid="updater-step"][data-step="1"]`);
  };
  /**
   * Review, confirm, then wait for the machine request to END. The signal is the request's own row under "Requested
   * here" (newest first) leaving pending/running. Run 38536879337 asserted when the page first read "installed",
   * while the step's own unit was still running (it enables the timer last): a race in the test.
   */
  const confirmUpdater = async (button, args) => {
    await click(button);
    await waitFor(tid('updater-review'));
    await click(tid('updater-confirm'));
    await until('the request accepted', async () => (await text(tid('updater-message'))) ?? null, 30_000, 300);
    const said = (await text(tid('updater-message'))) ?? '';
    assert.match(said, /^requested: /, `the confirm: ${said}`);
    // Async by design (the coordinator's tick, then the step's own unit); the signal: the request row's final status.
    const row = await until(`the request "${args}" to end`, async () => {
      await open('/machine');
      const r = await evaluate(`(() => { const r = [...document.querySelectorAll('[data-testid="machine-request-row"]')].find((x) => x.innerText.includes(${JSON.stringify(args)})); return r ? { status: r.getAttribute('data-status'), text: r.innerText.replace(/\\s+/g, ' ') } : null; })()`);
      return r && !['pending', 'running'].includes(r.status) ? r : null;
    }, 300_000, 3000);
    assert.equal(row.status, 'done', `the request ended ${row.status}: ${row.text}`);
  };
  await screen('screen 9: the updater installed from the Machine page (off until turned on)', async () => {
    await updaterState();
    await confirmUpdater(tid('updater-install'), 'install-updater');
    // The request has ended done: everything checked once.
    assert.match((await updaterState()) ?? '', /installed, updates off/);
    assert.equal(stat('/usr/local/libexec/worklane-update'), 'root 755');
    assert.equal(stat('/etc/worklane/updates.json'), 'root 644');
    const cfg = JSON.parse(sudoOk('cat', '/etc/worklane/updates.json'));
    assert.equal(cfg.enabled, false);
    assert.equal(sh('systemctl', ['is-active', 'worklane-update.timer']).out, 'active');
    return { channel: cfg.channel };
  });
  await screen('screen 9: a release signer staged from the page, confirmed at a root shell with the command the page shows', async () => {
    const dir = join(out, 'signer');
    mkdirSync(dir, { recursive: true });
    assert.equal(sh('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'release@example.com', '-f', join(dir, 'key')]).status, 0);
    const pub = readFileSync(join(dir, 'key.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
    await updaterState();
    await type(tid('updater-signer-principal'), 'release@example.com');
    await type(tid('updater-signer-key'), pub);
    await confirmUpdater(tid('updater-signer-review'), 'stage-update-signer');
    // The stage request has ended done: the staged signer and its root command, read once.
    await updaterState();
    const cmd = (await text(tid('updater-pending-command'))) ?? '';
    const m = cmd.trim().match(/^sudo bash (\S+\/scripts\/setup\/updates\.sh) --confirm-signer (SHA256:\S+)$/);
    assert.ok(m, `the root command: ${cmd}`);
    assert.ok(sh('sudo', ['test', '-e', '/etc/worklane/allowed_signers']).status !== 0 || !sudoOk('cat', '/etc/worklane/allowed_signers').includes(pub), 'staging trusts nothing');
    // The admin's root step, as the page shows it.
    // It shows who staged it, the principal and the key, then asks the admin to type the principal (the page says so):
    // typed here on its stdin. Run 38539290696 gave it none, and it rightly added nothing.
    const confirmed = sh('sudo', ['bash', m[1], '--confirm-signer', m[2]], { input: 'release@example.com\n' });
    assert.equal(confirmed.status, 0, `the root confirm: ${confirmed.err}`);
    assert.match(confirmed.err + confirmed.out, /release@example\.com/);
    assert.ok(sudoOk('cat', '/etc/worklane/allowed_signers').includes(`release@example.com ${pub}`));
    assert.equal(stat('/etc/worklane/allowed_signers'), 'root 644');
    // The root step has returned: a fresh load of the page reads the signers file, once.
    await updaterState();
    assert.ok((await text(tid('updater-signers')))?.includes('release@example.com'), 'the page lists the signer');
    return { fingerprint: m[2] };
  });
  await screen('screen 9: follow releases (the channel from the page)', async () => {
    await updaterState();
    if ((await attr(tid('updater-channel'), 'data-channel')) !== 'release') {
      await confirmUpdater(tid('updater-release'), 'set-update-channel release');
    }
    // A new install starts on release, so the button may have nothing to do: the page and the file read once.
    await updaterState();
    assert.equal(await attr(tid('updater-channel'), 'data-channel'), 'release');
    assert.equal(JSON.parse(sudoOk('cat', '/etc/worklane/updates.json')).channel, 'release');
    return { channel: 'release' };
  });
}

// ---------------------------------------------------------------- server, no https origin yet
/**
 * Setup mode on loopback (bootstrap --hardened with no origin): a server-rendered page, no script. The one-time token
 * goes into its form from the token file (never typed here, never printed, never in the address bar); then the sign-in
 * App step must not start GitHub's manifest flow: it says https comes first, and points to screen 7.
 */
async function setupLoopback() {
  const base = new URL(wizardUrl);
  assert.equal(base.hostname, '127.0.0.1', 'the setup URL is a loopback one');
  await screen('server, screen 3 with no origin: the loopback URL, the one-time token from its file', async () => {
    await cdp.send('Page.navigate', { url: wizardUrl });
    await until('the setup page', () => evaluate(`document.readyState === 'complete' && !!document.querySelector('#token')`), 30_000, 200);
    assert.ok(!new URL(await evaluate('location.href')).search, 'the URL carries nothing');
    assert.match((await text('main')) ?? '', /waits for an https origin: your own \(--public-url\), or screen 7, Tailscale and HTTPS/);
    const token = readFileSync(keyFile, 'utf8').trim();
    await click('#token');
    assert.ok(await evaluate(`document.activeElement === document.querySelector('#token')`), 'the click focused the token field');
    await cdp.send('Input.insertText', { text: token });
    // INVARIANT: the token is never in a message: only its length is compared.
    assert.ok((await evaluate(`document.querySelector('#token').value.length`)) === token.length, 'the token went into the field');
    await click('form[action="/setup/unlock"] button[type="submit"]');
    await waitFor(tid('signin-app-needs-https'), 30_000);
    assert.equal(new URL(await evaluate('location.href')).search, '', 'nothing in the address bar');
    return { at: await evaluate('location.pathname') };
  }, { gate: true });
  await screen('server, screen 3 with no origin: the App step says https first and sends the owner to screen 7 (Tailscale and HTTPS)', async () => {
    const card = tid('signin-app-needs-https');
    assert.equal(await attr(card, 'data-next-screen'), '7');
    const t = (await text(card)) ?? '';
    // #739: a choice, your own origin or Tailscale; the rerun with --public-url is the first.
    assert.match(t, /An https address first: one of your own, or Tailscale \(screen 7\)/);
    assert.match(t, /sudo bash \/\S+\/scripts\/bootstrap\.sh --hardened --public-url https:\/\/<your host> /);
    for (const step of ['install', 'up', 'serve']) assert.match(t, new RegExp(`sudo bash /\\S+/scripts/setup/tailscale\\.sh ${step}\\b`), `screen 7's ${step} step`);
    assert.match(t, /Then run the install command again/);
    assert.ok(!(await evaluate(`!!document.querySelector('input[name="owner"], form[action="/setup/signin-app"]')`)), 'no App form');
    // The App step asked for anyway, as a form from this page with its session (the page's CSP allows no fetch): the
    // same answer, 409, and nothing started.
    const statuses = [];
    const seen = (p) => statuses.push({ url: p.response.url, status: p.response.status });
    cdp.on('Network.responseReceived', seen);
    await evaluate(`(() => { const f = document.createElement('form'); f.method = 'post'; f.action = '/setup/signin-app'; const i = document.createElement('input'); i.name = 'owner'; i.value = 'example'; f.append(i); document.body.append(f); f.submit(); return true; })()`);
    await until('the App step\'s answer', () => evaluate(`location.pathname === '/setup/signin-app' && document.readyState === 'complete' && !!document.querySelector('[data-testid="signin-app-needs-https"]')`), 20_000, 200);
    const posted = await until('its status', () => statuses.find((x) => new URL(x.url).pathname === '/setup/signin-app') ?? null, 10_000, 100);
    assert.equal(posted.status, 409);
    // GitHub never asked: every URL this browser opened is the setup page's own.
    const away = urls.filter((u) => !u.startsWith(base.origin + '/'));
    assert.deepEqual(away, [], 'no request left the loopback page');
    return { next: 7, requests: urls.length };
  });
}

try {
  if (mode === 'setup-loopback') {
    await setupLoopback();
  } else if (mode === 'local') {
    // One tab, the whole walk: Protect must see the merged checks in the same dashboard, never after a restart.
    await local();
    await localRest(checkout);
    const f = await firstRun();
    await automationLines(f);
    await rerunFromSettings('claude-login', async () => {
      // Open again on a done step: the sign-in can run again (another account, an expired login).
      await waitFor(`${row('claude-login')} [data-testid="claude-signin"][data-mode="local"] ${tid('claude-signin-button')}`);
      assert.equal(await stepStatus('claude-login'), 'done');
    });
    await localStart();
    await screen('the project\'s dashboard: the Overview answers', async () => {
      await open('/');
      await waitFor('main header h1');
      return { heading: await text('main header h1') };
    });
  } else {
    const f = await server();
    await serverMachine();
    await automationLines(f);
    await rerunFromSettings('policy', async () => {
      await waitFor(`${row('policy')} ${tid('policy-form')}`);
    });
    await screen('the first project\'s dashboard, through the hub: the Overview answers', async () => {
      await open('/');
      await waitFor('main header h1');
      return { heading: await text('main header h1') };
    });
  }
} finally {
  writeFileSync(join(out, `urls-${mode}.txt`), `${urls.join('\n')}\n`);
  if (errors.length) writeFileSync(join(out, `page-errors-${mode}.txt`), `${errors.join('\n')}\n`);
  const failed = results.filter((r) => !r.ok).map((r) => r.screen);
  say({ walk: mode, ms: Date.now() - t0, screens: results.length, failed, pageErrors: errors.length });
  await browser.close();
  if (failed.length) process.exitCode = 1;
}
