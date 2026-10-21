// The bench's task images (#748, slice 4): `bench images` writes images.json, each selected task's pinned image
// reference, into the held-out store, from the store's manifest only. The name is the task's own under SWE-bench's
// naming, the digest is what the registry serves for that name, and it is taken only when it is one of pins.json's
// image_digests. Stand-ins only: fixture rows with synthetic ids (example__proj-NNNN), a temp bench root, a stand-in
// registry (no network), no docker, no model, no real store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentUser } from '../src/os/index.js';
import { BENCH_USER_ENV } from '../scripts/bench/auth.js';
import { benchLayout, type BenchLayout } from '../scripts/bench/paths.js';
// WHY: the isolation-preload guard: this file's process stops unless test/isolate.ts made its machine.
import { repoRoot } from './helpers.js';

void repoRoot;
const linux = { skip: process.platform !== 'linux' && 'the bench is Linux only' };

// WHY: loaded when a test runs, not at the top, so each test fails on its own on code from before this slice (the
// fail-without run).
const pinsMod = () => import('../scripts/bench/pins.js');
const sel = () => import('../scripts/bench/select.js');
const img = () => import('../scripts/bench/images.js');
const cli = () => import('../scripts/bench/cli.js');

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const uid = process.getuid?.() ?? 1000;

/** Anything shaped like an instance id or an instance image name: never in what the bench prints or throws. */
const TASKISH = /__|_1776_/;

const DATA = Buffer.from('fixture stand-in for the pinned dataset file, never a task\n');
const DATA_SHA = sha256(DATA);
const REV = '0123456789abcdef0123456789abcdef01234567';
const HOST = 'data.example.org';
const SEED = 20261018;

/** Synthetic instance ids in SWE-bench's shape (the repo's convention: never a real task's). */
const IDS = Array.from({ length: 60 }, (_, i) => `example__proj-${4200 + i}`);

const row = (id: string, i: number) => ({
  instance_id: id,
  repo: 'example/proj',
  base_commit: sha256(`base ${i}`).slice(0, 40),
  problem_statement: `Fixture problem ${i}.`,
  patch: `--- a/w.py\n+++ b/w.py\n@@ -1 +1 @@\n-x = ${i}\n+x = ${i + 1}\n`,
  test_patch: `--- a/t.py\n+++ b/t.py\n@@ -0,0 +1 @@\n+def test_w_${i}(): assert True\n`,
  FAIL_TO_PASS: JSON.stringify([`t.py::test_w_${i}`]),
  PASS_TO_PASS: '[]',
  hints_text: '',
  difficulty: '<15 min fix',
});
const jsonl = (rows: readonly object[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

/** The rows' canonical digest, as select.ts states it (the fields in its order, sorted by instance id). */
function canonicalSha(text: string): string {
  const rows = text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .sort((a, b) => ((a.instance_id as string) < (b.instance_id as string) ? -1 : 1));
  return sha256(rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/** The test's own statement of the rule: rank by sha256("<seed>:<instance id>"), ascending. */
const ranked = (ids: readonly string[]): string[] => [...ids].sort((a, b) => (sha256(`${SEED}:${a}`) < sha256(`${SEED}:${b}`) ? -1 : 1));

/** SWE-bench's image name for a task, as the README states it: the id in lower case, `__` as `_1776_`. */
const nameOf = (id: string): string => `swebench/sweb.eval.x86_64.${id.toLowerCase().split('__').join('_1776_')}`;
const MEDIA = 'application/vnd.oci.image.index.v1+json';
/** The manifest the stand-in registry serves for a task's image (it names no task). */
const bodyOf = (id: string): Buffer => Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: MEDIA, manifests: [], annotations: { fixture: sha256(id).slice(0, 16) } }));
const digestOf = (id: string): string => `sha256:${sha256(bodyOf(id))}`;
/** Pinned: one digest per fixture task, plus more, so the set holds at least 100. */
const DIGESTS = [...IDS.map(digestOf), ...Array.from({ length: 60 }, (_, i) => `sha256:${sha256(`other image ${i}`)}`)].sort();

const TOKEN = 'fixture.token-0123456789';
const TOKEN_URL = 'https://auth.docker.io/token';
const MANIFEST_URL = /^https:\/\/registry-1\.docker\.io\/v2\/(.+)\/manifests\/latest$/;

interface Call {
  url: string;
  headers: Readonly<Record<string, string>>;
  max: number;
}
interface Reply {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * A stand-in registry: the token endpoint answers a fixed token; a manifest request for a fixture task's image name
 * answers its manifest, unless `serve` answers otherwise for that instance id (undefined: the default).
 */
function registry(o: { serve?: (id: string, n: number) => Partial<Reply> | undefined; token?: Partial<Reply> } = {}) {
  const calls: Call[] = [];
  const byName = new Map(IDS.map((id) => [nameOf(id), id]));
  let n = 0;
  const fetch = async (url: string, headers: Readonly<Record<string, string>>, max: number): Promise<Reply> => {
    calls.push({ url, headers, max });
    if (url.startsWith(`${TOKEN_URL}?`)) return { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ token: TOKEN })), ...o.token };
    const m = MANIFEST_URL.exec(url);
    const id = m ? byName.get(m[1]!) : undefined;
    if (!id) return { status: 404, headers: {}, body: Buffer.from('{}') };
    const base: Reply = { status: 200, headers: { 'content-type': MEDIA, 'docker-content-digest': digestOf(id) }, body: bodyOf(id) };
    return { ...base, ...o.serve?.(id, n++) };
  };
  return { fetch, calls };
}

interface Bench {
  base: string;
  home: string;
  layout: BenchLayout;
  pinsText: string;
}

/** A temp bench root: the store (0700), the pinned dataset file and the rows, and (unless told not to) the manifest. */
async function bench(o: { ids?: string[]; digests?: string[]; manifest?: boolean } = {}): Promise<Bench> {
  const { parsePins } = await pinsMod();
  const { writeSelection } = await sel();
  const rowsText = jsonl((o.ids ?? IDS).map(row));
  const dataset = { base: `https://${HOST}/datasets/fixture/resolve/`, path: 'data/verified.parquet', revision: REV, sha256: DATA_SHA, max_bytes: 1024 * 1024, hosts: [HOST] };
  const pinsText = `${JSON.stringify({ dataset, image_digests: o.digests ?? DIGESTS, selection: { rule: 'sha256-rank-v1', seed: SEED, rows_sha256: canonicalSha(rowsText) } }, null, 2)}\n`;
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'bench-images-')));
  const home = join(base, 'home');
  mkdirSync(home);
  const layout = benchLayout(join(home, 'bench'));
  for (const d of [layout.root, layout.state, join(layout.state, 'evals'), join(layout.state, 'evals', 'held-out'), layout.heldOut, layout.data]) {
    mkdirSync(d, { mode: 0o700 });
    chmodSync(d, 0o700);
  }
  for (const [f, data] of [
    [join(layout.data, `${DATA_SHA}-verified.parquet`), DATA],
    [join(layout.data, 'rows.jsonl'), rowsText],
  ] as const) {
    writeFileSync(f, data, { mode: 0o600 });
    chmodSync(f, 0o600);
  }
  if (o.manifest !== false) writeSelection(layout, uid, parsePins(pinsText));
  return { base, home, layout, pinsText };
}

const imagesPath = (l: BenchLayout) => join(l.heldOut, 'images.json');

/** What the images file must hold for the fixture selection: every selected task, t01 first, to its own name@digest. */
const expected = (): Record<string, string> => Object.fromEntries(ranked(IDS).slice(0, 50).map((id) => [id, `${nameOf(id)}@${digestOf(id)}`]));

/** The bench command's deps on a temp bench machine: the bench user and its home. */
function cliDeps(b: { home: string }, out: string[], over: Record<string, unknown> = {}) {
  const env: NodeJS.ProcessEnv = { PATH: '/nonexistent', HOME: b.home, [BENCH_USER_ENV]: currentUser() };
  return { env, user: currentUser(), uid, euid: process.geteuid?.() ?? uid, passwdHome: () => b.home, out: (l: string) => out.push(l), ...over };
}

// ---- The image name ----

test("the image name is the task's own under SWE-bench's naming, and the run's own check agrees", async () => {
  const { taskImageName } = await img();
  const { imageNamesTask } = await sel();
  assert.equal(taskImageName('example__proj-4242'), 'swebench/sweb.eval.x86_64.example_1776_proj-4242');
  assert.equal(taskImageName('Example-Org__My.Proj-7'), 'swebench/sweb.eval.x86_64.example-org_1776_my.proj-7', 'lower case, as SWE-bench names it');
  for (const id of IDS) assert.ok(imageNamesTask(taskImageName(id), id), 'loadTasks takes the name it makes');
});

test('an instance id that SWE-bench naming does not cover is refused, naming no task', async () => {
  const { taskImageName } = await img();
  for (const [id, why] of [
    ['exampleproj-4242', 'no __'],
    ['example__proj', 'no number'],
    ['__proj-4242', 'no owner'],
    ['example__-4242', 'no repo'],
    ['example__proj_-4242', 'a name docker would refuse'],
    ['example__pr/oj-4242', 'a slash'],
    ['example__proj-4242@sha256', 'an @'],
    ['example__proj-4242:latest', 'a tag'],
    ['example__proj-42 42', 'a space'],
    ['example__pro..j-4242', 'a dot-dot that could walk a url path'],
    ['example__proj?x=1-4242', 'a query'],
    ['example__proj%2f-4242', 'a percent escape'],
    ['', 'empty'],
  ]) {
    let msg = '';
    assert.throws(() => taskImageName(id!), (e: Error) => ((msg = e.message), /naming/.test(msg)), why);
    assert.doesNotMatch(msg, TASKISH, `${why}: ${msg}`);
    assert.ok(!id || !msg.includes(id), `${why}: the refusal does not quote the id`);
  }
});

test("a reference is taken only under the task's own name, with a pinned digest, once per digest", async () => {
  const { parsePins } = await pinsMod();
  const { imageRefFor } = await img();
  const b = await bench({ manifest: false });
  const pins = parsePins(b.pinsText);
  const [a, c] = [IDS[0]!, IDS[1]!];
  const seen = new Map<string, string>();
  assert.equal(String(imageRefFor({ key: 't01', instanceId: a }, nameOf(a), digestOf(a), pins, seen)), `${nameOf(a)}@${digestOf(a)}`);
  const refuses = (f: () => unknown, re: RegExp, why: string) => {
    let msg = '';
    assert.throws(f, (e: Error) => ((msg = e.message), re.test(msg)), why);
    assert.doesNotMatch(msg, TASKISH, `${why}: ${msg}`);
  };
  refuses(() => imageRefFor({ key: 't02', instanceId: c }, nameOf(a), digestOf(c), pins, new Map()), /t02.*name/, "another task's name");
  refuses(() => imageRefFor({ key: 't02', instanceId: c }, nameOf(c), `sha256:${sha256('not pinned')}`, pins, new Map()), /t02.*not one of the pinned/, 'a digest not pinned');
  refuses(() => imageRefFor({ key: 't02', instanceId: c }, nameOf(c), digestOf(a), pins, seen), /t02.*t01/, "a digest t01 already has");
  refuses(() => imageRefFor({ key: 't02', instanceId: c }, `${nameOf(c)}:latest`, digestOf(c), pins, new Map()), /t02/, 'a tag');
});

// ---- The registry lookup ----

test("the registry lookup: fixed hosts, an anonymous pull token, the manifest's own sha256 as the digest", async () => {
  const { registryDigest } = await img();
  const r = registry();
  const id = IDS[3]!;
  assert.equal(await registryDigest(nameOf(id), r.fetch), digestOf(id));
  assert.equal(r.calls.length, 2);
  const [tok, man] = r.calls as [Call, Call];
  const t = new URL(tok.url);
  assert.equal(`${t.origin}${t.pathname}`, TOKEN_URL);
  assert.equal(t.searchParams.get('service'), 'registry.docker.io');
  assert.equal(t.searchParams.get('scope'), `repository:${nameOf(id)}:pull`);
  assert.equal(tok.headers.authorization, undefined, 'anonymous: no credential is sent');
  assert.equal(man.url, `https://registry-1.docker.io/v2/${nameOf(id)}/manifests/latest`);
  assert.equal(man.headers.authorization, `Bearer ${TOKEN}`);
  for (const t of ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.oci.image.manifest.v1+json']) assert.ok(man.headers.accept?.includes(t), t);
  assert.ok(man.max > 0 && man.max <= 4 * 1024 * 1024, 'a capped body');
  // No header digest: the body's own sha256 is the digest.
  const noHeader = registry({ serve: () => ({ headers: { 'content-type': MEDIA } }) });
  assert.equal(await registryDigest(nameOf(id), noHeader.fetch), digestOf(id));
});

test('the registry lookup fails closed on anything unexpected, and never quotes the image name', async () => {
  const { registryDigest } = await img();
  const id = IDS[3]!;
  const other = digestOf(IDS[4]!);
  const cases: [ReturnType<typeof registry>, RegExp, string][] = [
    [registry({ serve: () => ({ headers: { 'content-type': MEDIA, 'docker-content-digest': other } }) }), /digest/, 'a header digest that is not the body'],
    [registry({ serve: () => ({ headers: { 'content-type': 'text/html' } }) }), /type/, 'not a manifest'],
    [registry({ serve: () => ({ headers: { 'content-type': 'application/vnd.docker.distribution.manifest.v1+prettyjws' } }) }), /type/, 'a schema 1 manifest'],
    [registry({ serve: () => ({ status: 307, headers: { location: 'https://elsewhere.example/x' } }) }), /HTTP 307/, 'a redirect'],
    [registry({ serve: () => ({ status: 404 }) }), /HTTP 404/, 'not found'],
    [registry({ serve: () => ({ status: 401 }) }), /HTTP 401/, 'not authorised'],
    [registry({ serve: () => ({ body: Buffer.from('not json') }) }), /manifest/, 'a body that is not JSON'],
    [registry({ serve: () => ({ body: Buffer.from(JSON.stringify({ schemaVersion: 1, mediaType: MEDIA })) }) }), /manifest/, 'schema version 1'],
    [registry({ serve: () => ({ body: Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.docker.distribution.manifest.v2+json' })) }) }), /manifest/, 'a media type that is not the content type'],
    [registry({ serve: () => ({ body: Buffer.alloc(5 * 1024 * 1024, 0x20) }) }), /bytes/, 'a body over the cap'],
    [registry({ token: { status: 500 } }), /token.*HTTP 500/, 'no token'],
    [registry({ token: { body: Buffer.from(JSON.stringify({ token: 'bad token\r\nX-Injected: 1' })) } }), /token/, 'a token that is not header-safe'],
    [registry({ token: { body: Buffer.from(JSON.stringify({ access_token: 7 })) } }), /token/, 'no token field'],
  ];
  for (const [r, re, why] of cases) {
    let msg = '';
    await assert.rejects(registryDigest(nameOf(id), r.fetch), (e: Error) => ((msg = e.message), re.test(msg)), why);
    assert.doesNotMatch(msg, TASKISH, `${why}: ${msg}`);
  }
  // A thrown fetch whose message quotes the url: never passed on.
  let msg = '';
  const leaky = async (url: string) => {
    throw new Error(`fetch failed for ${url}`);
  };
  await assert.rejects(registryDigest(nameOf(id), leaky), (e: Error) => ((msg = e.message), /registry/.test(msg)));
  assert.doesNotMatch(msg, TASKISH, msg);
  // A name that is not a digest reference's name: refused before any request.
  const r = registry();
  await assert.rejects(registryDigest('Not/A Name', r.fetch), /name/);
  assert.equal(r.calls.length, 0);
});

// ---- bench images: the file ----

test('writeImages: every selected task, from the manifest, to its own name at a pinned digest; 0600, verified, and the run takes it', linux, async () => {
  const { parsePins } = await pinsMod();
  const { writeImages } = await img();
  const { loadTasks } = await sel();
  const b = await bench();
  const pins = parsePins(b.pinsText);
  const r = registry();
  const s = await writeImages(b.layout, uid, pins, r.fetch);
  assert.equal(s.written, true);
  assert.equal(s.keys.length, 50);
  assert.equal(s.keys[0], 't01');
  assert.equal(s.keys.at(-1), 't50');
  const f = imagesPath(b.layout);
  const st = lstatSync(f);
  assert.ok(st.isFile());
  assert.equal(st.mode & 0o7777, 0o600);
  assert.equal(st.uid, uid);
  assert.equal(st.nlink, 1, 'the verified temporary name is gone');
  assert.deepEqual(readdirSync(b.layout.heldOut).sort(), ['dataset', 'images.json', 'manifest.json'], 'no temporary file left');
  const text = readFileSync(f, 'utf8');
  assert.equal(s.sha256, sha256(text));
  assert.deepEqual(JSON.parse(text), expected());
  assert.deepEqual(Object.keys(JSON.parse(text) as object), ranked(IDS).slice(0, 50), 'in key order');
  // The run's own check takes it, smoke and baseline.
  assert.equal(loadTasks(b.layout, uid, pins, 'smoke').length, 4);
  assert.equal(loadTasks(b.layout, uid, pins, 'baseline').length, 50);
  // Again: the same file, kept, not rewritten.
  const again = await writeImages(b.layout, uid, pins, registry().fetch);
  assert.equal(again.written, false);
  assert.equal(again.sha256, s.sha256);
  assert.equal(lstatSync(f).ino, st.ino);
});

test('writeImages fails closed, writing nothing: no manifest, a store that fails its check, no digest pinned, an edited manifest', linux, async () => {
  const { parsePins } = await pinsMod();
  const { writeImages } = await img();
  const refuses = async (b: Bench, re: RegExp, why: string, pinsText = b.pinsText) => {
    const r = registry();
    let msg = '';
    await assert.rejects(writeImages(b.layout, uid, parsePins(pinsText), r.fetch), (e: Error) => ((msg = e.message), re.test(msg)), why);
    assert.doesNotMatch(msg, TASKISH, `${why}: ${msg}`);
    assert.ok(!existsSync(imagesPath(b.layout)), `${why}: nothing written`);
    assert.equal(r.calls.length, 0, `${why}: refused before any registry request`);
  };
  await refuses(await bench({ manifest: false }), /bench select/, 'no manifest');
  // Pins that parsePins didn't make (a copy of real ones): refused.
  const copy = await bench();
  const forged = { ...parsePins(copy.pinsText) };
  const fr = registry();
  await assert.rejects(writeImages(copy.layout, uid, forged as never, fr.fetch), /pins file/);
  assert.equal(fr.calls.length, 0);
  const open = await bench();
  chmodSync(open.layout.heldOut, 0o750);
  await refuses(open, /0700/, 'a 0750 store');
  chmodSync(open.layout.heldOut, 0o700);
  const none = await bench({ digests: [] });
  await refuses(none, /pinned/, 'no image digest pinned');
  const edited = await bench();
  const mf = join(edited.layout.heldOut, 'manifest.json');
  const m = JSON.parse(readFileSync(mf, 'utf8')) as { tasks: { instance_id: string }[] };
  [m.tasks[0]!.instance_id, m.tasks[1]!.instance_id] = [m.tasks[1]!.instance_id, m.tasks[0]!.instance_id];
  writeFileSync(mf, `${JSON.stringify(m, null, 2)}\n`);
  await refuses(edited, /manifest/, 'a manifest edited by hand');
  // Another seed since bench select: the manifest isn't what the pins select now.
  const seeded = await bench();
  await refuses(seeded, /manifest/, 'another seed since select', seeded.pinsText.replace(`"seed": ${SEED}`, `"seed": ${SEED + 1}`));
  // An instance id SWE-bench's naming doesn't cover: refused at its key.
  const odd = await bench({ ids: IDS.map((id) => id.replace('__', '-')) });
  await refuses(odd, /t01.*naming/, 'an unknown naming');
});

test("writeImages fails closed on the registry's answers: a digest not pinned, two tasks with one digest; nothing written", linux, async () => {
  const { parsePins } = await pinsMod();
  const { writeImages } = await img();
  const order = ranked(IDS);
  const refuses = async (serve: (id: string) => Partial<Reply> | undefined, re: RegExp, why: string) => {
    const b = await bench();
    let msg = '';
    await assert.rejects(writeImages(b.layout, uid, parsePins(b.pinsText), registry({ serve }).fetch), (e: Error) => ((msg = e.message), re.test(msg)), why);
    assert.doesNotMatch(msg, TASKISH, `${why}: ${msg}`);
    assert.ok(!existsSync(imagesPath(b.layout)), `${why}: nothing written`);
    return msg;
  };
  const unpinned = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: MEDIA, manifests: [], annotations: { fixture: 'moved' } }));
  const msg = await refuses((id) => (id === order[2] ? { body: unpinned, headers: { 'content-type': MEDIA } } : undefined), /t03.*not one of the pinned/, 'a digest not pinned');
  assert.ok(msg.includes(`sha256:${sha256(unpinned)}`), 'the refusal gives the digest the registry served, for the owner to check');
  await refuses((id) => (id === order[1] ? { body: bodyOf(order[0]!), headers: { 'content-type': MEDIA } } : undefined), /t02.*t01/, 'two tasks, one digest');
  await refuses((id) => (id === order[49] ? { status: 404 } : undefined), /t50.*HTTP 404/, 'the last task not found');
});

test('writeImages never replaces anything: a different file, a link, or a file that appears during the lookups', linux, async () => {
  const { parsePins } = await pinsMod();
  const { writeImages } = await img();
  // A different images file already there: refused, untouched.
  const d = await bench();
  writeFileSync(imagesPath(d.layout), '{}\n', { mode: 0o600 });
  chmodSync(imagesPath(d.layout), 0o600);
  await assert.rejects(writeImages(d.layout, uid, parsePins(d.pinsText), registry().fetch), /different/);
  assert.equal(readFileSync(imagesPath(d.layout), 'utf8'), '{}\n');
  // A link where it goes: refused before any request; the place it names untouched.
  const l = await bench();
  const target = join(l.base, 'elsewhere.json');
  writeFileSync(target, 'untouched\n', { mode: 0o600 });
  symlinkSync(target, imagesPath(l.layout));
  const lr = registry();
  await assert.rejects(writeImages(l.layout, uid, parsePins(l.pinsText), lr.fetch), /link/);
  assert.equal(lr.calls.length, 0);
  assert.equal(readFileSync(target, 'utf8'), 'untouched\n');
  // A file that appears while the registry is asked: refused, never replaced.
  const a = await bench();
  const ar = registry({
    serve: (_id, n) => {
      if (n === 10) writeFileSync(imagesPath(a.layout), 'planted\n', { mode: 0o600 });
      return undefined;
    },
  });
  await assert.rejects(writeImages(a.layout, uid, parsePins(a.pinsText), ar.fetch), /different|appeared/);
  assert.equal(readFileSync(imagesPath(a.layout), 'utf8'), 'planted\n');
  // The store opened up during the lookups: refused, nothing written.
  const o = await bench();
  const or = registry({
    serve: (_id, n) => {
      if (n === 10) chmodSync(o.layout.heldOut, 0o755);
      return undefined;
    },
  });
  await assert.rejects(writeImages(o.layout, uid, parsePins(o.pinsText), or.fetch), /0700/);
  chmodSync(o.layout.heldOut, 0o700);
  assert.ok(!existsSync(imagesPath(o.layout)));
  // The manifest swapped during the lookups: refused, nothing written.
  const m = await bench();
  const mf = join(m.layout.heldOut, 'manifest.json');
  const mr = registry({
    serve: (_id, n) => {
      if (n === 10) {
        const j = JSON.parse(readFileSync(mf, 'utf8')) as { tasks: { instance_id: string }[] };
        [j.tasks[0]!.instance_id, j.tasks[1]!.instance_id] = [j.tasks[1]!.instance_id, j.tasks[0]!.instance_id];
        writeFileSync(mf, `${JSON.stringify(j, null, 2)}\n`);
      }
      return undefined;
    },
  });
  await assert.rejects(writeImages(m.layout, uid, parsePins(m.pinsText), mr.fetch), /manifest/);
  assert.ok(!existsSync(imagesPath(m.layout)));
});

// ---- The bench command ----

test('bench images: takes no argument, prints keys, counts and digests only, and then bench select passes every line', linux, async () => {
  const { parsePins } = await pinsMod();
  const { main, images, select } = await cli();
  const help: string[] = [];
  assert.equal(main(['help'], { out: (l: string) => help.push(l) }), 0);
  assert.match(help.join('\n'), /images/);
  const b = await bench();
  // An argument (an instance id, a name, a seed): refused before anything runs.
  for (const arg of [IDS[0]!, nameOf(IDS[0]!), String(SEED)]) {
    const out: string[] = [];
    const r = registry();
    assert.equal(await main(['images', arg], { ...cliDeps(b, out), registry: r.fetch } as never), 2);
    assert.match(out.join('\n'), /takes no arguments/);
    assert.doesNotMatch(out.join('\n'), TASKISH);
    assert.equal(r.calls.length, 0);
    assert.ok(!existsSync(imagesPath(b.layout)));
  }
  const out: string[] = [];
  const pins = () => parsePins(b.pinsText);
  assert.equal(await images(cliDeps(b, out, { registry: registry().fetch }) as never, pins), 0, out.join('\n'));
  const text = out.join('\n');
  assert.match(text, /PASS +images.*50 tasks.*t01\.\.t50/);
  assert.match(text, new RegExp(sha256(readFileSync(imagesPath(b.layout)))));
  assert.match(text, /PASS +run check/);
  assert.doesNotMatch(text, TASKISH, 'no instance id or image name printed');
  for (const id of IDS) assert.ok(!text.includes(digestOf(id)), "no task's own digest beside its key on success");
  // bench select now passes every line.
  const sOut: string[] = [];
  assert.equal(select(cliDeps(b, sOut) as never, pins), 0, sOut.join('\n'));
  assert.doesNotMatch(sOut.join('\n'), /FAIL/);
  assert.match(sOut.join('\n'), /PASS +images/);
});

test('bench images: a refusal is one FAIL line with keys and digests, exit 1, nothing written', linux, async () => {
  const { parsePins } = await pinsMod();
  const { images } = await cli();
  const b = await bench();
  const order = ranked(IDS);
  const moved = Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: MEDIA, manifests: [], annotations: { fixture: 'moved' } }));
  const out: string[] = [];
  const r = registry({ serve: (id) => (id === order[0] ? { body: moved, headers: { 'content-type': MEDIA } } : undefined) });
  assert.equal(await images(cliDeps(b, out, { registry: r.fetch }) as never, () => parsePins(b.pinsText)), 1);
  const text = out.join('\n');
  assert.match(text, new RegExp(`FAIL +images +t01: .*sha256:${sha256(moved)}`));
  assert.doesNotMatch(text, TASKISH);
  assert.ok(!existsSync(imagesPath(b.layout)));
  // Not the bench user: refused before the store or the registry.
  const other: string[] = [];
  const r2 = registry();
  assert.equal(await images(cliDeps(b, other, { registry: r2.fetch, env: { PATH: '/nonexistent', HOME: b.home, [BENCH_USER_ENV]: 'someone-else' } }) as never, () => parsePins(b.pinsText)), 1);
  assert.match(other.join('\n'), /FAIL/);
  assert.equal(r2.calls.length, 0);
});
