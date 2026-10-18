// docs/previews.md. INVARIANT: the host's API and GitHub are fakes on this machine; the token is a test value.
import { GATE_MODES, guardGate } from './gate-helpers.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config/load.js';
import { AppConfig, TestsConfig } from '../src/config/schema.js';
import { asks } from '../src/console/asks.js';
import { HOST_TOKEN_CREDENTIAL } from '../src/deploy-gate/config.js';
import { hostTokenFile } from '../src/deploy-gate/wire.js';
import { EventLog } from '../src/events/log.js';
import { PreviewConfig, previewPr } from '../src/preview/config.js';
import { githubPreviews, PREVIEW_RELEASE_TAG, type OpenPr, type PreviewGitHub } from '../src/preview/github.js';
import { PREVIEW_COMMENT_MARKER } from '../src/preview/previews.js';
import { PREVIEW_QUERIES } from '../src/preview/railway.js';
import { setupPreviews } from '../src/preview/wire.js';
import type { FlowEvidence } from '../src/browser/run.js';
import { repoRoot } from './helpers.js';

const PROJECT = '00000000-0000-4000-8000-000000000001';
const TEMPLATE = '00000000-0000-4000-8000-000000000002';
const WEB = '00000000-0000-4000-8000-000000000003';
const WORKER = '00000000-0000-4000-8000-000000000004';
const TOKEN = 'host-token-value-never-shown-0123456789';
const HEAD = (n: number, v = 'a') => `${v}${String(n).padStart(3, '0')}`.padEnd(40, '0');

const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

interface Env {
  id: string;
  name: string;
  createdAt: string;
}

/** WHY: `statuses(service)` is what each new deployment reports, poll by poll, so a deploy can stall or fail. */
async function fakeRailway(o: { envs?: Env[]; statuses?: (service: string) => string[]; staticUrl?: (env: string) => string | null; onStatus?: () => void } = {}) {
  const calls: { auth: string | undefined; query: string; variables: Record<string, unknown> }[] = [];
  const envs: Env[] = [...(o.envs ?? [])];
  const deps = new Map<string, { env: string; service: string; polls: string[] }>();
  let seq = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const j = JSON.parse(body) as { query: string; variables: Record<string, unknown> };
      calls.push({ auth: req.headers.authorization, query: j.query, variables: j.variables });
      const send = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return res.writeHead(200).end(JSON.stringify({ errors: [{ message: 'Not Authorized' }] }));
      const v = j.variables;
      switch (j.query) {
        case PREVIEW_QUERIES.ENVS:
          assert.equal(v.p, PROJECT);
          return send({ environments: { edges: envs.map((node) => ({ node })) } });
        case PREVIEW_QUERIES.CREATE: {
          const i = v.i as { projectId: string; name: string; sourceEnvironmentId: string };
          assert.equal(i.projectId, PROJECT);
          assert.equal(i.sourceEnvironmentId, TEMPLATE);
          const e = { id: `env-${++seq}`, name: i.name, createdAt: new Date(now.t).toISOString() };
          envs.push(e);
          return send({ environmentCreate: { id: e.id } });
        }
        case PREVIEW_QUERIES.DELETE: {
          const k = envs.findIndex((e) => e.id === v.id);
          if (k >= 0) envs.splice(k, 1);
          return send({ environmentDelete: k >= 0 });
        }
        case PREVIEW_QUERIES.DEPLOY: {
          const id = `dep-${++seq}`;
          deps.set(id, { env: String(v.e), service: String(v.s), polls: [...(o.statuses?.(String(v.s)) ?? ['BUILDING', 'SUCCESS'])] });
          return send({ serviceInstanceDeployV2: id });
        }
        case PREVIEW_QUERIES.STATUS: {
          o.onStatus?.();
          const d = deps.get(String(v.id))!;
          const status = d.polls.length > 1 ? d.polls.shift()! : d.polls[0]!;
          return send({ deployment: { id: v.id, status, staticUrl: d.service === WEB ? (o.staticUrl ? o.staticUrl(d.env) : `${d.env}.example.test`) : null } });
        }
        case PREVIEW_QUERIES.DOMAIN:
          return send({ serviceDomainCreate: { domain: `made-${String((v.i as { environmentId: string }).environmentId)}.example.test` } });
      }
      res.writeHead(400).end('{}');
    });
  });
  const url = `${await listen(server)}/graphql/v2`;
  const of = (q: keyof typeof PREVIEW_QUERIES) => calls.filter((c) => c.query === PREVIEW_QUERIES[q]);
  return { url, calls, envs, server, of };
}

function fakeGitHub(prs: OpenPr[]) {
  const comments = new Map<number, { pr: number; body: string }>();
  const assets = new Map<string, number>();
  let id = 100;
  const gh: PreviewGitHub = {
    openPrs: async () => prs.map((p) => ({ ...p })),
    comment: async (pr, cid, body) => {
      const k = cid ?? ++id;
      comments.set(k, { pr, body });
      return k;
    },
    attach: async (name, png) => {
      assets.set(name, png.length);
      return `https://github.example.test/assets/${name}`;
    },
    detach: async (prefix) => {
      for (const k of [...assets.keys()]) if (k.startsWith(prefix)) assets.delete(k);
    },
  };
  return { gh, prs, comments, assets };
}

const now = { t: Date.parse('2026-10-13T10:00:00Z') };

const previewConfig = (o: Record<string, unknown> = {}) =>
  PreviewConfig.parse({
    enabled: true,
    project: PROJECT,
    template_environment: TEMPLATE,
    services: [
      { name: 'web', id: WEB },
      { name: 'worker', id: WORKER },
    ],
    url_service: 'web',
    ...o,
  });

const APP = AppConfig.parse({ version: 1, start: { command: 'false', port: 5173 }, ui_paths: ['web/**'], flows: { home: [{ goto: '/' }], cart: [{ goto: '/cart' }] } });

async function setup(o: { token?: boolean; prs: OpenPr[]; envs?: Env[]; config?: Record<string, unknown>; statuses?: (service: string) => string[]; staticUrl?: (env: string) => string | null; flowFails?: boolean }) {
  const base = mkdtempSync(join(tmpdir(), 'preview-'));
  const home = join(base, 'home');
  if (o.token !== false) {
    const file = hostTokenFile('example', home);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${TOKEN}\n`, { mode: 0o400 });
  }
  const stateDir = join(base, 'state');
  mkdirSync(stateDir);
  const log = new EventLog(join(base, 'events.db'));
  const host = await fakeRailway({ ...(o.envs ? { envs: o.envs } : {}), ...(o.statuses ? { statuses: o.statuses } : {}), ...(o.staticUrl ? { staticUrl: o.staticUrl } : {}), onStatus: () => (now.t += 30_000) });
  const github = fakeGitHub(o.prs);
  const checkout = join(base, 'checkout');
  cpSync(join(repoRoot, 'examples', 'basic'), checkout, { recursive: true });
  const cfg = loadConfig(checkout);
  cfg.tests.preview = previewConfig(o.config);
  cfg.app = APP;
  const flowsRun: { flow: string; origin: string }[] = [];
  const previews = setupPreviews(
    cfg,
    {
      repo: 'example/repo',
      token: async () => 'gh-token',
      instance: 'example',
      secretsHome: home,
      hostApi: host.url,
      previewGitHub: github.gh,
      previewPassMs: 0,
      previewPollMs: 0,
      previewNow: () => now.t,
      runFlow: async ({ flow, origin, outDir }) => {
        flowsRun.push({ flow, origin });
        const screenshot = join(outDir, `${flow}.png`);
        writeFileSync(screenshot, Buffer.alloc(2000, 1));
        const ev: FlowEvidence = { flow, ok: !o.flowFails, steps: [{ step: 'goto /', ok: !o.flowFails, ms: 5, ...(o.flowFails ? { error: 'nothing there' } : {}) }], consoleErrors: [], failedRequests: [], slowRequests: [], blockedRequests: [], trace: null, screenshot, views: [], viewErrors: [], durationMs: 5 };
        return ev;
      },
    },
    { log, actor: 'coordinator', stateDir },
  );
  assert.ok(previews, 'set up');
  const pass = async () => {
    previews.step();
    await previews.idle();
  };
  const of = (type: string) => log.read(0, [type as never]).map((e) => e.payload as Record<string, unknown>);
  return { base, log, host, github, previews, pass, of, flowsRun, done: () => host.server.close() };
}

test('preview config: off by default; `{enabled: false}` alone is valid; on needs the project, template, services and url_service', () => {
  assert.equal(PreviewConfig.parse({}).enabled, false);
  const tests = { version: 1, runner: { kind: 'command', changed: 'node --test', full: 'node --test', one: 'node --test {file}' } };
  assert.equal(TestsConfig.parse({ ...tests, preview: { enabled: false } }).preview?.enabled, false);
  assert.equal(TestsConfig.parse(tests).preview, undefined);
  const d = PreviewConfig.parse({ enabled: false });
  assert.deepEqual([d.max_concurrent, d.timeout_s, d.ttl_hours], [2, 1200, 72]);
  const bad = PreviewConfig.safeParse({ enabled: true });
  assert.equal(bad.success, false);
  assert.deepEqual(bad.error!.issues.map((i) => i.path.join('.')).sort(), ['project', 'services', 'template_environment', 'url_service']);
  assert.equal(PreviewConfig.safeParse({ ...previewConfig(), url_service: 'api' }).success, false, 'url_service must be one of the services');
  assert.deepEqual(['pr-preview-7', 'pr-preview-0', 'pr-preview-7x', 'production', 'pr-preview-', 'x-pr-preview-7'].map(previewPr), [7, null, null, null, null, null]);
});

test('preview off (absent, or enabled false): nothing is built, so nothing is created, posted or deleted', () => {
  const base = mkdtempSync(join(tmpdir(), 'preview-off-'));
  cpSync(join(repoRoot, 'examples', 'basic'), base, { recursive: true });
  const cfg = loadConfig(base);
  const log = new EventLog(join(base, 'events.db'));
  const s = { repo: 'example/repo', token: async () => 'gh-token', instance: 'example' };
  assert.equal(setupPreviews(cfg, s, { log, actor: 'coordinator', stateDir: base }), undefined);
  cfg.tests.preview = PreviewConfig.parse({ enabled: false, project: PROJECT });
  assert.equal(setupPreviews(cfg, s, { log, actor: 'coordinator', stateDir: base }), undefined);
});

test('a PR opens: its preview is forked from the template, deployed at the head, its flows run at the URL, and the URL and screenshots are posted; it is deleted when the PR closes', async () => {
  const prs: OpenPr[] = [
    { number: 7, head: HEAD(7), sameRepo: true },
    { number: 8, head: HEAD(8), sameRepo: false },
  ];
  const t = await setup({ prs });
  try {
    await t.pass();
    assert.deepEqual(t.host.of('CREATE').map((c) => (c.variables.i as { name: string }).name), ['pr-preview-7'], "one preview, and none for the fork's PR");
    const env = t.host.envs.find((e) => e.name === 'pr-preview-7')!.id;
    assert.deepEqual(
      t.host.of('DEPLOY').map((c) => c.variables),
      [
        { s: WEB, e: env, c: HEAD(7) },
        { s: WORKER, e: env, c: HEAD(7) },
      ],
      'every service, in the preview, at the head',
    );
    assert.ok(t.host.calls.every((c) => c.auth === `Bearer ${TOKEN}`), 'the stored token on every call');
    assert.deepEqual(t.flowsRun, [
      { flow: 'home', origin: `https://${env}.example.test` },
      { flow: 'cart', origin: `https://${env}.example.test` },
    ]);
    const [comment] = [...t.github.comments.values()];
    assert.equal(comment!.pr, 7);
    assert.ok(comment!.body.startsWith(PREVIEW_COMMENT_MARKER));
    assert.match(comment!.body, new RegExp(`URL: https://${env}\\.example\\.test`));
    assert.match(comment!.body, /`home`: pass\n {2}!\[home\]\(https:\/\/github\.example\.test\/assets\/pr-7-a0070000-home\.png\)/);
    assert.deepEqual([...t.github.assets.keys()].sort(), ['pr-7-a0070000-cart.png', 'pr-7-a0070000-home.png']);
    assert.deepEqual(t.of('preview.ready').map((p) => [p.pr, p.url]), [[7, `https://${env}.example.test`]]);
    assert.ok(!JSON.stringify(t.log.read(0)).includes(TOKEN), 'the token is in no event');

    await t.pass();
    assert.equal(t.host.of('CREATE').length, 1);
    assert.equal(t.host.of('DEPLOY').length, 2);

    prs[0]!.head = HEAD(7, 'b');
    await t.pass();
    assert.equal(t.host.of('CREATE').length, 1);
    assert.deepEqual(t.host.of('DEPLOY').slice(2).map((c) => [c.variables.e, c.variables.c]), [[env, HEAD(7, 'b')], [env, HEAD(7, 'b')]]);
    assert.equal(t.github.comments.size, 1, 'one comment, edited in place');
    assert.deepEqual([...t.github.assets.keys()].sort(), ['pr-7-b0070000-cart.png', 'pr-7-b0070000-home.png'], "the old head's screenshots are gone");

    prs.splice(0, 1);
    await t.pass();
    assert.deepEqual(t.host.of('DELETE').map((c) => c.variables.id), [env]);
    assert.deepEqual(t.of('preview.removed'), [{ pr: 7, environment: env, reason: 'closed', ok: true }]);
    assert.deepEqual([...t.github.assets.keys()], []);
    assert.equal(t.host.envs.length, 0);
  } finally {
    t.done();
  }
});

test('at most max_concurrent previews: a PR past the cap waits (said once), and gets one when a slot frees', async () => {
  const prs: OpenPr[] = [1, 2, 3].map((n) => ({ number: n, head: HEAD(n), sameRepo: true }));
  const t = await setup({ prs });
  try {
    await t.pass();
    await t.pass();
    assert.deepEqual(t.host.envs.map((e) => e.name), ['pr-preview-1', 'pr-preview-2']);
    assert.deepEqual(t.of('preview.waiting').map((p) => [p.pr, p.active, p.max]), [[3, 2, 2]], 'said once, not every pass');
    prs.splice(0, 1);
    await t.pass();
    assert.deepEqual(t.host.envs.map((e) => e.name).sort(), ['pr-preview-2', 'pr-preview-3']);
  } finally {
    t.done();
  }
});

test('leaks: a preview of a closed PR or older than ttl_hours is deleted (and not made again for the same head); the template and other environments never are', async () => {
  const old = new Date(now.t - 80 * 3_600_000).toISOString();
  const recent = new Date(now.t - 3_600_000).toISOString();
  const envs: Env[] = [
    { id: 'env-old', name: 'pr-preview-5', createdAt: old },
    { id: 'env-closed', name: 'pr-preview-9', createdAt: recent },
    { id: TEMPLATE, name: 'pr-preview-11', createdAt: old },
    { id: 'env-prod', name: 'production', createdAt: old },
    { id: 'env-other', name: 'staging-pr-preview-9', createdAt: old },
  ];
  const t = await setup({ prs: [{ number: 5, head: HEAD(5), sameRepo: true }], envs });
  try {
    await t.pass();
    assert.deepEqual(t.host.of('DELETE').map((c) => c.variables.id).sort(), ['env-closed', 'env-old']);
    assert.deepEqual(t.of('preview.removed').map((p) => [p.pr, p.reason]).sort(), [[5, 'expired'], [9, 'closed']]);
    assert.deepEqual(t.host.of('CREATE'), [], 'an expired preview is not made again for the same head');
    assert.deepEqual(t.host.envs.map((e) => e.id).sort(), [TEMPLATE, 'env-other', 'env-prod']);
  } finally {
    t.done();
  }
});

test('a deploy that never finishes is deleted after timeout_s; a failed deploy is deleted at once; each says so on the PR and is not retried until the head moves', async () => {
  const prs: OpenPr[] = [{ number: 4, head: HEAD(4), sameRepo: true }];
  const t = await setup({ prs, config: { timeout_s: 120 }, statuses: () => ['BUILDING'] });
  try {
    await t.pass();
    assert.deepEqual(t.of('preview.failed').map((p) => [p.pr, p.outcome]), [[4, 'timed_out']]);
    assert.equal(t.host.envs.length, 0, 'deleted');
    assert.deepEqual(t.of('preview.removed').map((p) => p.reason), ['failed']);
    assert.match([...t.github.comments.values()][0]!.body, /No preview of `a0040000`: the host didn't finish deploying within 120 s/);
    assert.deepEqual(t.flowsRun, []);
    await t.pass();
    assert.equal(t.host.of('CREATE').length, 1, 'not retried at the same head');
  } finally {
    t.done();
  }
  const f = await setup({ prs: [{ number: 6, head: HEAD(6), sameRepo: true }], statuses: (s) => (s === WORKER ? ['BUILDING', 'FAILED'] : ['SUCCESS']) });
  try {
    await f.pass();
    assert.deepEqual(f.of('preview.failed').map((p) => [p.outcome, p.detail]), [['deploy_failed', "the host's deploy of worker ended FAILED"]]);
    assert.equal(f.host.envs.length, 0);
  } finally {
    f.done();
  }
});

test('no domain on the deployment: one is generated for url_service; a failing flow is reported on the PR, not hidden', async () => {
  const t = await setup({ prs: [{ number: 3, head: HEAD(3), sameRepo: true }], staticUrl: () => null, flowFails: true });
  try {
    await t.pass();
    const env = t.host.envs[0]!.id;
    assert.deepEqual(t.host.of('DOMAIN').map((c) => c.variables.i), [{ environmentId: env, serviceId: WEB }]);
    assert.equal(t.flowsRun[0]!.origin, `https://made-${env}.example.test`);
    assert.match([...t.github.comments.values()][0]!.body, /`home`: fail: step "goto \/" failed: nothing there/);
    assert.deepEqual(t.of('preview.ready')[0]!.flows, [
      { flow: 'home', status: 'fail', detail: 'step "goto /" failed: nothing there' },
      { flow: 'cart', status: 'fail', detail: 'step "goto /" failed: nothing there' },
    ]);
  } finally {
    t.done();
  }
});

test('no host token stored: the host is never called, and that is said once', async () => {
  const t = await setup({ token: false, prs: [{ number: 2, head: HEAD(2), sameRepo: true }] });
  try {
    await t.pass();
    await t.pass();
    assert.deepEqual(t.host.calls, []);
    assert.equal(t.of('preview.error').length, 1);
    const open = asks(t.log).list({ instance: 'example', status: 'open' });
    assert.deepEqual(open.map((a) => [a.kind, a.kind === 'paste_secret' ? a.credential : null]), [['paste_secret', HOST_TOKEN_CREDENTIAL]], "the owner is asked for the deploy gate's own credential, once");
  } finally {
    t.done();
  }
});

test('GitHub side: open PRs (a fork told apart), one comment edited in place, screenshots as assets of a draft release, removed by PR', async () => {
  const seen: { method: string; path: string; type?: string; body: string }[] = [];
  const assets: { id: number; name: string }[] = [{ id: 1, name: 'pr-12-aaaa-home.png' }, { id: 2, name: 'pr-123-aaaa-home.png' }];
  const releases: { id: number; draft: boolean; tag_name: string }[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = req.url ?? '';
      seen.push({ method: req.method ?? '', path, ...(req.headers['content-type'] ? { type: String(req.headers['content-type']) } : {}), body });
      assert.equal(req.headers.authorization, 'Bearer gh-token');
      const json = (s: number, d: unknown) => res.writeHead(s, { 'content-type': 'application/json' }).end(JSON.stringify(d));
      if (path.startsWith('/repos/example/repo/pulls?')) return json(200, [{ number: 12, head: { sha: HEAD(12), repo: { full_name: 'example/repo' } } }, { number: 13, head: { sha: HEAD(13), repo: { full_name: 'someone/fork' } } }]);
      if (path === '/repos/example/repo/issues/12/comments' && req.method === 'POST') return json(201, { id: 555 });
      if (path === '/repos/example/repo/issues/comments/555' && req.method === 'PATCH') return json(200, { id: 555 });
      if (path === '/repos/example/repo/releases?per_page=100') return json(200, releases);
      if (path === '/repos/example/repo/releases' && req.method === 'POST') {
        releases.push({ id: 77, draft: true, tag_name: PREVIEW_RELEASE_TAG });
        return json(201, { id: 77 });
      }
      if (path.startsWith('/up/repos/example/repo/releases/77/assets?name=')) return json(201, { browser_download_url: `https://github.example.test/download/${new URL(path, 'http://x').searchParams.get('name')}` });
      if (path.startsWith('/repos/example/repo/releases/77/assets?')) return json(200, assets);
      if (path.startsWith('/repos/example/repo/releases/assets/') && req.method === 'DELETE') return res.writeHead(204).end();
      json(404, {});
    });
  });
  const url = await listen(server);
  try {
    const gh = githubPreviews('example/repo', async () => 'gh-token', fetch, url, `${url}/up`);
    assert.deepEqual(await gh.openPrs(), [
      { number: 12, head: HEAD(12), sameRepo: true },
      { number: 13, head: HEAD(13), sameRepo: false },
    ]);
    assert.equal(await gh.comment(12, null, 'one'), 555);
    assert.equal(await gh.comment(12, 555, 'two'), 555);
    assert.equal(await gh.attach('pr-12-aaaa-home.png', Buffer.from('png')), 'https://github.example.test/download/pr-12-aaaa-home.png');
    const created = seen.find((s) => s.method === 'POST' && s.path === '/repos/example/repo/releases')!;
    assert.deepEqual(JSON.parse(created.body).draft, true, 'a draft: no tag, nothing in git');
    assert.equal(seen.find((s) => s.path.startsWith('/up/'))!.type, 'image/png');
    await gh.detach('pr-12-');
    assert.deepEqual(seen.filter((s) => s.method === 'DELETE').map((s) => s.path), ['/repos/example/repo/releases/assets/1'], "only PR 12's, never PR 123's");
    assert.equal(seen.filter((s) => s.method === 'POST' && s.path === '/repos/example/repo/releases').length, 1, 'the release is made once');
  } finally {
    server.close();
  }
});

for (const mode of GATE_MODES) {
  test(`a preview is held at the start gate (${mode}): nothing created, deployed or run, nothing failed; it launches once there is room`, async () => {
    const g = guardGate();
    const t = await setup({ prs: [{ number: 7, head: HEAD(7), sameRepo: true }] });
    try {
      g.close(mode);
      await t.pass();
      await t.pass();
      assert.equal(t.host.of('CREATE').length, 0, 'nothing created');
      assert.equal(t.host.of('DEPLOY').length, 0);
      assert.deepEqual(t.flowsRun, []);
      assert.deepEqual(t.of('preview.failed'), [], 'held is not a failure');
      g.open();
      await t.pass();
      assert.deepEqual(t.host.of('CREATE').map((c) => (c.variables.i as { name: string }).name), ['pr-preview-7']);
      assert.equal(t.of('preview.ready').length, 1);
    } finally {
      g.done();
      t.done();
    }
  });
}
