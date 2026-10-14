#!/usr/bin/env node
// Dev only: measure how fast the dashboard is over a slow link, the way a person reaches it through the hub.
// A hub and four instance dashboards on loopback (port 0, temporary state), each instance its own process with a
// synthetic event log (test/synthetic-events.ts, a fixed seed), a fake GitHub for the hub's sign-in and the
// instances' role reads, and headless Chrome (src/browser/cdp.ts launchChrome) with its network slowed by the
// DevTools protocol (Network.emulateNetworkConditions). It then times a cold first load, a warm reload, an instance
// switch and the page switches Overview -> Board -> PRs -> Health, through the hub and straight to an instance.
//
//   npm run build && npm run build:web
//   nice node scripts/dev/perf-dashboard.mjs [--events 200000,50000,20000,5000] [--seed 1] [--latency 120]
//       [--kbps 385] [--runs 3] [--github-ms 0] [--json <file>] [--engine <built checkout>] [--chrome <path>]
//       [--no-chrome-sandbox] [--keep]
//
// --latency: the round trip Chrome adds to every request (ms); --kbps: its download and upload throughput (kbit/s;
// 385 is 717 KB in 14.9 s, as measured through a relay); --github-ms: how long the fake GitHub takes to answer (the
// hub re-reads each instance's role from GitHub on every /api/hub). Prints a Markdown report; --json writes the raw
// numbers. Each step's server time comes from the servers themselves (a wrapper around their request handlers).
import { fork } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const option = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const engine = resolve(option('--engine', fileURLToPath(new URL('../..', import.meta.url))));
const load = (m) => import(pathToFileURL(join(engine, 'dist', m)).href);

/** Wrap a server's request handler: each request's time in the server, by method and path, until it ends. */
function timed(server, sink) {
  const [handler] = server.listeners('request');
  server.removeAllListeners('request');
  let connections = 0;
  server.on('connection', () => connections++);
  server.on('request', (req, res) => {
    const t = performance.now();
    const path = (req.url ?? '/').split('?')[0];
    res.on('finish', () => sink.push({ method: req.method, path, ms: performance.now() - t, status: res.statusCode, bytes: Number(res.getHeader('content-length') ?? 0) || null, encoding: res.getHeader('content-encoding') ?? null }));
    handler(req, res);
  });
  return () => connections;
}

// ---- an instance's dashboard, in a process of its own (forked below with --serve) ----
if (argv[0] === '--serve') {
  const o = JSON.parse(argv[1]);
  const { startDashboard } = await load('src/dashboard.js');
  const { loadConfig } = await load('src/config/load.js');
  const { cachedRoles, repoPermission } = await load('src/dashboard-auth.js');
  const cfg = loadConfig(o.root);
  const roleOf = cachedRoles(repoPermission({ repo: 'example-org/demo', token: async () => 'fake-installation-token', api: o.gh }));
  const d = await startDashboard({ root: o.root, cfg, eventsDb: o.eventsDb, stateDir: o.stateDir, slotsDir: o.slotsDir, user: 'example-owner', roleOf, instance: o.name, port: 0, policyFile: null });
  const sink = [];
  const conns = timed(d.server, sink);
  process.on('message', (m) => {
    if (m === 'take') process.send({ timings: sink.splice(0), connections: conns(), rss: process.memoryUsage().rss });
    if (m === 'stop') void d.close().then(() => process.exit(0));
  });
  process.send({ url: d.url, token: d.token, engine });
} else {
  await main();
}

async function main() {
  // The generator from this checkout (it may be newer than the engine measured).
  const { writeSyntheticLog } = await import(new URL('../../dist/test/synthetic-events.js', import.meta.url).href);
  const { launchChrome, findChrome, freePort, sleep, until } = await load('src/browser/cdp.js');
  const { startHub } = await load('src/dashboard-hub.js');
  const { BRAND } = await load('src/brand.js');
  const sizes = option('--events', '200000,50000,20000,5000').split(',').map(Number);
  const names = ['busy', 'b', 'c', 'd'].slice(0, sizes.length);
  const seed = Number(option('--seed', 1));
  const latency = Number(option('--latency', 120));
  const kbps = Number(option('--kbps', 385));
  const runs = Number(option('--runs', 3));
  const githubMs = Number(option('--github-ms', 0));
  const chrome = findChrome(option('--chrome', process.env.CHROME));
  if (!chrome) throw new Error('no Chrome or Chromium found; pass --chrome <path>');
  const work = mkdtempSync(join(tmpdir(), 'dash-perf-'));
  const children = [];
  let browser = null;
  let gh = null;
  let hub = null;
  try {
    // A demo project for the config the instances run with; their logs are synthetic.
    process.env[`${BRAND.envPrefix}_STATE_DIR`] = join(work, 'demo-state');
    const seeded = spawnSync(process.execPath, [join(engine, 'dist', 'src', 'cli.js'), 'demo', join(work, 'demo')], { encoding: 'utf8', env: process.env });
    const root = seeded.stdout.match(/project (.+)/)?.[1]?.trim();
    if (seeded.status !== 0 || !root) throw new Error(`seeding the demo failed:\n${seeded.stdout}${seeded.stderr}`);

    // The fake GitHub: sign-in for the hub, and every login an admin on the instances' repo.
    const url0 = (u) => new URL(u, 'http://x');
    gh = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () =>
        setTimeout(() => {
          const url = new URL(req.url, 'http://x');
          const send = (s, j) => (res.writeHead(s, { 'content-type': 'application/json' }), res.end(JSON.stringify(j)));
          if (url.pathname === '/login/oauth/authorize') {
            const back = new URL(url.searchParams.get('redirect_uri'));
            back.searchParams.set('code', 'fake-example-owner');
            back.searchParams.set('state', url.searchParams.get('state'));
            res.writeHead(302, { location: back.toString() });
            return res.end();
          }
          if (url.pathname === '/login/oauth/access_token') return send(200, { access_token: 'ghu_example-owner' });
          if (url.pathname === '/user') return send(200, { login: 'example-owner' });
          if (/\/collaborators\/[^/]+\/permission$/.test(url.pathname)) return send(200, { permission: 'admin' });
          send(404, { message: 'Not Found' });
        }, url0(req.url).pathname.includes('/permission') ? githubMs : 0),
      );
    });
    await new Promise((r) => gh.listen(0, '127.0.0.1', r));
    const ghUrl = `http://127.0.0.1:${gh.address().port}`;

    const instances = [];
    for (const [i, name] of names.entries()) {
      const stateDir = join(work, name);
      mkdirSync(stateDir, { recursive: true });
      const eventsDb = join(stateDir, 'events.db');
      const t = performance.now();
      writeSyntheticLog(eventsDb, { count: sizes[i], seed: seed + i, instance: name, end: new Date() });
      process.stderr.write(`perf: ${name}: ${sizes[i]} events written in ${Math.round(performance.now() - t)} ms\n`);
      const child = fork(fileURLToPath(import.meta.url), ['--serve', JSON.stringify({ name, root, eventsDb, stateDir, slotsDir: join(work, 'slots'), gh: ghUrl }), '--engine', engine], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      children.push(child);
      const ready = await new Promise((r, f) => (child.once('message', r), child.once('exit', (c) => f(new Error(`${name}'s dashboard exited ${c}`)))));
      // WHY: the instances must run the engine measured, not this script's checkout.
      if (ready.engine !== engine) throw new Error(`${name}'s dashboard ran ${ready.engine}, not ${engine}`);
      instances.push({ name, child, url: ready.url, token: ready.token, tokenFile: join(stateDir, 'dashboard-token'), events: sizes[i] });
    }
    const hubSink = [];
    const hubPort = await freePort();
    hub = await startHub({
      instances: instances.map((i) => ({ name: i.name, port: Number(new URL(i.url).port), tokenFile: i.tokenFile })),
      stateDir: join(work, 'hub'),
      port: hubPort,
      signIn: { clientId: 'Iv1.devfakeclient', clientSecret: 'dev-fake-client-secret', sessionSecret: randomBytes(32).toString('hex'), publicUrl: `http://127.0.0.1:${hubPort}`, web: ghUrl, api: ghUrl },
    });
    timed(hub.server, hubSink);
    const hubBase = `http://127.0.0.1:${hubPort}`;

    browser = await launchChrome(chrome, { noSandbox: flag('--no-chrome-sandbox'), profileRoot: work, extraArgs: ['--force-prefers-reduced-motion'] });
    const cdp = browser.cdp;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Performance.enable');
    // Every document: when the page last changed (its render), and the long tasks.
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__perf = { lastMutation: 0, long: [] };
        new MutationObserver(() => (window.__perf.lastMutation = performance.now())).observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
        try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.long.push({ start: e.startTime, ms: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch {}`,
    });
    const evaluate = async (expression) => {
      const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    // Requests in flight (the live stream left out: it never ends).
    const inflight = new Map();
    const requests = [];
    cdp.on('Network.requestWillBeSent', (p) => {
      if (/\/stream(\?|$)/.test(p.request.url)) return;
      inflight.set(p.requestId, p.request.url);
    });
    cdp.on('Network.responseReceived', (p) => {
      const r = requests.find((x) => x.id === p.requestId);
      if (r) r.response = p.response;
      else requests.push({ id: p.requestId, response: p.response });
    });
    const finished = (p) => inflight.delete(p.requestId);
    cdp.on('Network.loadingFinished', finished);
    cdp.on('Network.loadingFailed', finished);

    // Signed in at full speed (not measured), then the link slowed.
    await cdp.send('Page.navigate', { url: `${hubBase}/auth/login` });
    await until('the sign-in', async () => (await evaluate('location.pathname + "|" + document.readyState')) === '/|complete', 20_000);
    const bytesPerSec = (kbps * 1000) / 8;
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency, downloadThroughput: bytesPerSec, uploadThroughput: bytesPerSec });

    const take = async () => {
      const out = await Promise.all(instances.map((i) => new Promise((r) => (i.child.once('message', r), i.child.send('take')))));
      return Object.fromEntries(instances.map((i, k) => [i.name, out[k]]));
    };
    /** Wait until the page shows `testid` and nothing has been asked for 400 ms; then what it cost. */
    const settle = async (testid, t0) => {
      await until(`[data-testid="${testid}"]`, () => evaluate(`!!document.querySelector('[data-testid="${testid}"]')`), 120_000, 20).catch(async (e) => {
        throw new Error(`${e.message}\nthe page: ${await evaluate('location.href + " | " + document.body.innerText.slice(0, 400)').catch(() => '?')}\nin flight: ${[...inflight.values()].join(', ')}`);
      });
      // A server slower than the page's own polling never goes quiet: given up on after 90 s, and marked so.
      let quiet = 0;
      let settled = true;
      const giveUp = Date.now() + 90_000;
      while (quiet < 400) {
        await sleep(50);
        quiet = inflight.size ? 0 : quiet + 50;
        if (Date.now() > giveUp) {
          settled = false;
          process.stderr.write(`perf: never quiet; still waiting on ${[...inflight.values()].join(', ')}\n`);
          break;
        }
      }
      const page = await evaluate(`(() => {
        const t0 = ${t0};
        const res = performance.getEntriesByType('resource').filter((e) => e.startTime >= t0 - 1 && !/\\/stream(\\?|$)/.test(e.name));
        const nav = performance.getEntriesByType('navigation')[0];
        const all = [...(t0 === 0 && nav ? [nav] : []), ...res].map((e) => ({ url: e.name.replace(location.origin, ''), start: e.startTime, end: e.responseEnd, ttfb: e.responseStart - e.requestStart, transfer: e.transferSize, encoded: e.encodedBodySize, decoded: e.decodedBodySize, cached: e.transferSize === 0 && e.decodedBodySize > 0 }));
        const lastNet = Math.max(t0, ...all.map((e) => e.end));
        const done = Math.max(lastNet, window.__perf.lastMutation);
        const long = window.__perf.long.filter((l) => l.start >= t0);
        return { ms: done - t0, network: lastNet - t0, renderAfterData: Math.max(0, window.__perf.lastMutation - lastNet), longTasks: long.length, longMs: long.reduce((s, l) => s + l.ms, 0), requests: all };
      })()`);
      return { ...page, settled };
    };
    /** Round trips: each request's depth is one more than the deepest request that ended before it began. */
    const waterfall = (reqs) => {
      const sorted = [...reqs].sort((a, b) => a.start - b.start);
      const depth = new Map();
      for (const r of sorted) depth.set(r, 1 + Math.max(0, ...sorted.filter((q) => q !== r && q.end <= r.start + 1).map((q) => depth.get(q) ?? 0)));
      const stages = [];
      for (const r of sorted) (stages[depth.get(r) - 1] ??= []).push(r.url.replace(/\/assets\/(index-)?[^/]*\.(js|css)$/, '/assets/*.$2').split('?')[0]);
      return { depth: stages.length, stages: stages.map((s) => s.join(', ')) };
    };
    const metric = async (name) => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === name)?.value ?? 0;

    const results = [];
    const step = async (label, via, act, testid) => {
      await take();
      hubSink.length = 0;
      const script0 = await metric('ScriptDuration');
      // Only this step's requests count: anything the last document left unfinished is gone with it.
      inflight.clear();
      const t0 = await act();
      const page = await settle(testid, t0);
      // A new document starts its own count: a load's is all of it.
      const script = (await metric('ScriptDuration')) - (t0 === 0 ? 0 : script0);
      const servers = await take();
      const inst = Object.entries(servers).flatMap(([name, s]) => s.timings.map((t) => ({ ...t, instance: name })));
      const hubT = hubSink.splice(0);
      const r = { label, via, ...page, scriptMs: script * 1000, waterfall: waterfall(page.requests), server: inst, hub: hubT, connections: Object.fromEntries(Object.entries(servers).map(([n, s]) => [n, s.connections])), rss: Object.fromEntries(Object.entries(servers).map(([n, s]) => [n, s.rss])) };
      results.push(r);
      process.stderr.write(`perf: ${via} ${label}: ${Math.round(r.ms)} ms (${page.requests.length} requests, ${r.waterfall.depth} round trips)\n`);
      return r;
    };
    const navigate = async (url) => {
      await cdp.send('Page.navigate', { url });
      return 0;
    };
    const reload = async () => {
      await cdp.send('Page.reload', {});
      return 0;
    };
    const click = (testid) => async () => evaluate(`(() => { const t = performance.now(); document.querySelector('[data-testid="${testid}"]').click(); return t; })()`);
    // From the Overview a load lands on: Board, PRs, Health, and back to the Overview.
    const pages = [['board', 'nav-board'], ['prs', 'nav-prs'], ['health', 'nav-health'], ['overview', 'nav-overview']];

    // Bundle evaluation: from a trace of the cold load.
    let bundle = null;
    for (let n = 0; n < runs; n++) {
      // Through the hub, as a signed-in person: a cold first load (empty cache), then a warm reload.
      await evaluate(`sessionStorage.setItem('dash-instance', 'busy'); sessionStorage.removeItem('dash-all-instances')`);
      await cdp.send('Network.clearBrowserCache');
      const events = [];
      const collect = (p) => events.push(...p.value);
      if (n === 0) {
        cdp.on('Tracing.dataCollected', collect);
        await cdp.send('Tracing.start', { categories: 'devtools.timeline,v8', transferMode: 'ReportEvents' });
      }
      await step('first load (cold cache)', 'hub', () => navigate(`${hubBase}/overview`), 'page-overview');
      if (n === 0) {
        const done = new Promise((r) => cdp.on('Tracing.tracingComplete', r));
        await cdp.send('Tracing.end');
        await done;
        // Whatever the trace calls compiling and evaluating the bundle (a module script: v8.compileModule,
        // v8.evaluateModule; a classic one: v8.compile, EvaluateScript), summed per name, complete events only.
        const bundleUrl = /\/assets\/index-[^/"]*\.js/;
        const byName = {};
        for (const e of events) {
          if (e.ph !== 'X' || !/compile|evaluate|parse/i.test(e.name) || !bundleUrl.test(JSON.stringify(e.args ?? {}))) continue;
          byName[e.name] = (byName[e.name] ?? 0) + (e.dur ?? 0) / 1000;
        }
        bundle = byName;
      }
      await step('reload (warm cache)', 'hub', reload, 'page-overview');
      // Switch instance: what the switcher does (web/src/api.ts selectInstance): remember it, reload.
      const switchTo = (name) => async () => {
        await evaluate(`sessionStorage.setItem('dash-instance', ${JSON.stringify(name)})`);
        return reload();
      };
      await step(`instance switch -> ${names[1]} (${sizes[1]} events)`, 'hub', switchTo(names[1]), 'page-overview');
      await step(`instance switch -> ${names[0]} (${sizes[0]} events)`, 'hub', switchTo(names[0]), 'page-overview');
      for (const [page, nav] of pages) await step(`page switch -> ${page}`, 'hub', click(nav), `page-${page}`);

      // Straight to the busy instance's own dashboard (its break-glass key), for the hub's own cost.
      const direct = instances[0];
      await cdp.send('Page.navigate', { url: `${direct.url}/` });
      await evaluate(`sessionStorage.setItem('dash-token', ${JSON.stringify(direct.token)})`);
      await step(n ? 'reload (warm cache)' : 'first load (cold cache)', 'direct', () => navigate(`${direct.url}/overview`), 'page-overview');
      for (const [page, nav] of pages) await step(`page switch -> ${page}`, 'direct', click(nav), `page-${page}`);
      await cdp.send('Page.navigate', { url: `${hubBase}/overview` });
      await sleep(500);
    }
    const rss = (await take());
    const report = summarize({ engine, results, bundle, rss, sizes, names, latency, kbps, runs, githubMs, seed });
    process.stdout.write(report);
    const json = option('--json');
    if (json) writeFileSync(json, JSON.stringify({ results, bundle, rss, options: { sizes, latency, kbps, runs, githubMs, seed } }, null, 2));
  } finally {
    if (browser) await browser.close();
    if (hub) await hub.close();
    for (const c of children) c.kill();
    gh?.close();
    if (!flag('--keep')) rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  }
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0;
}
function r0(x) {
  return Math.round(x);
}
function kb(b) {
  return `${(b / 1024).toFixed(1)} KB`;
}

function summarize(o) {
  const lines = [];
  lines.push(`Engine: ${o.engine}. Link: ${o.latency} ms added per round trip, ${o.kbps} kbit/s each way. Logs: ${o.names.map((n, i) => `${n} ${o.sizes[i]}`).join(', ')} events (seed ${o.seed}). Fake GitHub answers in ${o.githubMs} ms. Median of ${o.runs} runs.`);
  lines.push('');
  lines.push('| step | via | total ms | network ms | render after data ms | requests | round trips | bytes on the wire | script ms | slowest server endpoint (ms) | hub hop ms (median per call) |');
  lines.push('|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|');
  const keys = [...new Set(o.results.map((r) => `${r.via}\u0000${r.label}`))];
  for (const k of keys) {
    const [via, label] = k.split('\u0000');
    const rs = o.results.filter((r) => r.via === via && r.label === label);
    const server = new Map();
    for (const r of rs) for (const t of r.server) server.set(t.path, [...(server.get(t.path) ?? []), t.ms]);
    const slowest = [...server.entries()].map(([p, ms]) => [p, median(ms)]).sort((a, b) => b[1] - a[1])[0];
    // The hub's hop: its time for a forwarded call less the instance's own for the same path.
    const hops = [];
    for (const r of rs) for (const h of r.hub) {
      const m = h.path.match(/^\/api\/i\/[^/]+(\/.+)$/);
      if (!m) continue;
      const own = r.server.find((t) => t.path === `/api${m[1]}`);
      if (own) hops.push(h.ms - own.ms);
    }
    lines.push(`| ${label} | ${via} | ${r0(median(rs.map((r) => r.ms)))}${rs.some((r) => !r.settled) ? ' (never quiet: 90 s cap)' : ''} | ${r0(median(rs.map((r) => r.network)))} | ${r0(median(rs.map((r) => r.renderAfterData)))} | ${median(rs.map((r) => r.requests.length))} | ${median(rs.map((r) => r.waterfall.depth))} | ${kb(median(rs.map((r) => r.requests.reduce((s, q) => s + (q.transfer || 0), 0))))} | ${r0(median(rs.map((r) => r.scriptMs)))} | ${slowest ? `${slowest[0]} ${r0(slowest[1])}` : '-'} | ${hops.length ? r0(median(hops)) : '-'} |`);
  }
  lines.push('');
  lines.push('Server time per endpoint (median ms, the busy instance, every step):');
  lines.push('');
  lines.push('| endpoint | calls | median ms | max ms | encoding |');
  lines.push('|---|---:|---:|---:|---|');
  const per = new Map();
  for (const r of o.results) for (const t of r.server.filter((t) => t.instance === o.names[0])) per.set(t.path, [...(per.get(t.path) ?? []), t]);
  for (const [p, ts] of [...per.entries()].sort((a, b) => median(b[1].map((t) => t.ms)) - median(a[1].map((t) => t.ms)))) lines.push(`| ${p} | ${ts.length} | ${r0(median(ts.map((t) => t.ms)))} | ${r0(Math.max(...ts.map((t) => t.ms)))} | ${[...new Set(ts.map((t) => t.encoding ?? 'none'))].join(', ')} |`);
  lines.push('');
  const first = o.results.find((r) => r.label.startsWith('first load'));
  if (first) {
    lines.push('Cold first load, request by request (first run):');
    lines.push('');
    lines.push('| request | start ms | end ms | on the wire | body | encoding |');
    lines.push('|---|---:|---:|---:|---:|---|');
    for (const q of [...first.requests].sort((a, b) => a.start - b.start)) {
      const enc = first.server.find((t) => q.url.endsWith(t.path))?.encoding ?? (q.encoded < q.decoded ? 'compressed' : 'none');
      lines.push(`| ${q.url.split('?')[0]} | ${r0(q.start)} | ${r0(q.end)} | ${kb(q.transfer)} | ${kb(q.decoded)} | ${enc} |`);
    }
    lines.push('');
    lines.push(`Round trips of the cold load: ${first.waterfall.stages.map((s, i) => `${i + 1}. ${s}`).join('; ')}`);
    lines.push('');
  }
  if (o.bundle) lines.push(`Bundle parse and evaluation (trace of the cold load, ms): ${Object.entries(o.bundle).map(([n, ms]) => `${n} ${r0(ms)}`).join(', ') || 'none found in the trace'}.`);
  const conns = o.results.at(-1)?.connections;
  if (conns) lines.push(`TCP connections each instance accepted over the whole run (the hub's to it, and Chrome's direct ones): ${Object.entries(conns).map(([n, c]) => `${n} ${c}`).join(', ')}.`);
  lines.push(`Instance dashboards' RSS at the end: ${Object.entries(o.rss).map(([n, s], i) => `${n} (${o.sizes[i]} events) ${Math.round(s.rss / 1048576)} MB`).join(', ')}.`);
  return `${lines.join('\n')}\n`;
}
