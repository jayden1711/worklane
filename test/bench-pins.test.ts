// The bench's pinned downloads (#748, slice 2): the dataset at a pinned revision and sha256, into the 0700 held-out
// store, and images by digest only. Stand-ins only: a fetcher that serves fixture bytes from memory, a recording
// docker function, a temp home. Nothing here reaches a network, a registry, a daemon or a real store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentUser } from '../src/os/index.js';
import { BENCH_USER_ENV } from '../scripts/bench/auth.js';
import { benchLayout, type BenchLayout } from '../scripts/bench/paths.js';
import type { DockerCall } from '../scripts/bench/container.js';
import type { Fetcher } from '../scripts/bench/download.js';
// WHY: the isolation-preload guard: this file's process stops unless test/isolate.ts made its machine.
import { repoRoot } from './helpers.js';

const linux = { skip: process.platform !== 'linux' && 'the bench is Linux only' };

// WHY: loaded when a test runs, not at the top, so each test fails on its own on code from before these modules
// (the fail-without run).
const pinsMod = () => import('../scripts/bench/pins.js');
const dl = () => import('../scripts/bench/download.js');
const cli = () => import('../scripts/bench/cli.js');

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const uid = process.getuid?.() ?? 1000;

const DATA = Buffer.from('{"row": 1, "note": "fixture bytes, never a task"}\n{"row": 2}\n');
const SHA = sha256(DATA);
const REV = '0123456789abcdef0123456789abcdef01234567';
const HOST = 'data.example.org';
const BASE = `https://${HOST}/datasets/fixture/resolve/`;
const URL_AT_REV = `${BASE}${REV}/data/verified.jsonl`;
const FILE = `${SHA}-verified.jsonl`;

/** Sorted digests, as many as the pins file needs to hold a set (never a selection). */
const DIGESTS = Array.from({ length: 120 }, (_, i) => `sha256:${sha256(`image ${i}`)}`).sort();
const D = DIGESTS[7]!;

interface PinsOver {
  revision?: string | null;
  sha256?: string | null;
  digests?: string[];
  base?: string;
  path?: string;
  hosts?: string[];
  max?: number;
  dataset?: Record<string, unknown>;
  extra?: Record<string, unknown>;
}

/** A pins file's text, as scripts/bench/pins.json holds it, pinned to the fixture bytes unless told otherwise. */
function pinsText(o: PinsOver = {}): string {
  const dataset = { base: o.base ?? BASE, path: o.path ?? 'data/verified.jsonl', revision: o.revision === undefined ? REV : o.revision, sha256: o.sha256 === undefined ? SHA : o.sha256, max_bytes: o.max ?? 1024 * 1024, hosts: o.hosts ?? [HOST], ...o.dataset };
  return JSON.stringify({ dataset, image_digests: o.digests ?? [], ...o.extra }, null, 2);
}

interface Route {
  status: number;
  location?: string;
  body?: Buffer[];
  /** Throw after the body's chunks (a connection cut mid-file). */
  cut?: boolean;
}

/** A fetcher stand-in: serves `routes` from memory and records every URL asked. No network. */
function server(routes: Record<string, Route>): { fetch: Fetcher; calls: string[] } {
  const calls: string[] = [];
  const fetch: Fetcher = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return { status: 404, location: null, body: null };
    const body = r.body
      ? (async function* () {
          for (const b of r.body!) yield new Uint8Array(b);
          if (r.cut) throw new Error('connection reset');
        })()
      : null;
    return { status: r.status, location: r.location ?? null, body };
  };
  return { fetch, calls };
}

const serving = (body: Buffer = DATA) => server({ [URL_AT_REV]: { status: 200, body: [body.subarray(0, 10), body.subarray(10)] } });

/** A temp bench root (not made: the download makes what it needs) and its layout. */
function bench(): { base: string; home: string; layout: BenchLayout } {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'bench-pins-')));
  const home = join(base, 'home');
  mkdirSync(home);
  return { base, home, layout: benchLayout(join(home, 'bench')) };
}

/** Every file and folder under `dir`, relative, sorted. */
const tree = (dir: string): string[] => (existsSync(dir) ? (readdirSync(dir, { recursive: true }) as string[]).sort() : []);
const mode = (p: string): number => lstatSync(p).mode & 0o7777;

// ---- The pins file ----

test('the pins file: one closed schema, a revision and a sha256 together or neither, never an instance id', async () => {
  const { parsePins } = await pinsMod();
  const p = parsePins(pinsText());
  assert.ok(p.dataset, 'pinned');
  assert.equal(p.dataset.url, URL_AT_REV, 'the url is built at the pinned revision');
  assert.equal(p.dataset.sha256, SHA);
  assert.equal(p.dataset.file, FILE, 'stored under its sha256');
  const unpinned = parsePins(pinsText({ revision: null, sha256: null }));
  assert.equal(unpinned.dataset, null, 'unpinned: nothing to download');
  const refused: [string, string][] = [
    [pinsText({ revision: null }), 'a sha256 without a revision'],
    [pinsText({ sha256: null }), 'a revision without a sha256'],
    [pinsText({ revision: 'main' }), 'a branch, not a commit'],
    [pinsText({ revision: REV.toUpperCase() }), 'upper-case hex'],
    [pinsText({ sha256: SHA.slice(1) }), 'a short sha256'],
    [pinsText({ extra: { tasks: ['t01'] } }), 'an unknown top-level key'],
    [pinsText({ dataset: { note: 'free text' } }), 'an unknown dataset key'],
    [pinsText({ base: `http://${HOST}/x/` }), 'plain http'],
    [pinsText({ base: `https://user:pw@${HOST}/x/` }), 'credentials in the url'],
    [pinsText({ base: `https://${HOST}:8443/x/` }), 'a port'],
    [pinsText({ base: `https://${HOST}/x/?a=1` }), 'a query'],
    [pinsText({ base: 'https://elsewhere.example.net/x/' }), 'a host not in the list'],
    [pinsText({ path: '../outside.jsonl' }), 'a path climbing out'],
    [pinsText({ path: '/abs.jsonl' }), 'an absolute path'],
    [pinsText({ max: 0 }), 'no size cap'],
    [pinsText({ hosts: [] }), 'no host'],
    [pinsText({ path: 'data/django__django-11099.jsonl' }), 'an instance id'],
    [pinsText({ path: 'data/sweb.eval.x86_64.django_1776_django-11099.jsonl' }), 'an instance image name'],
    [pinsText({ digests: DIGESTS.slice(0, 4) }), 'a handful of digests: a selection, not a set'],
    [pinsText({ digests: [...DIGESTS].reverse() }), 'unsorted digests'],
    [pinsText({ digests: [...DIGESTS, DIGESTS[0]!].sort() }), 'a digest twice'],
    [pinsText({ digests: [...DIGESTS.slice(1), 'swebench/example:latest'] }), 'a tag in the digest set'],
    ['not json', 'not JSON'],
  ];
  for (const [text, why] of refused) assert.throws(() => parsePins(text), Error, why);
});

test("the repo's pins file parses, sets nothing but the pins, and names no task", async () => {
  const { loadPins, PINS_FILE } = await pinsMod();
  assert.equal(PINS_FILE, join(repoRoot, 'scripts', 'bench', 'pins.json'), 'the one pins file, in this clone');
  const pins = loadPins();
  const text = readFileSync(PINS_FILE, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text) as object).sort(), ['dataset', 'image_digests']);
  assert.doesNotMatch(text, /__|_1776_|:latest|swebench\//, 'no instance id, image name or tag');
  if (pins.dataset) assert.match(pins.dataset.url, new RegExp(`/${pins.dataset.revision}/`));
});

test('a pin comes only from the pins file: a hand-made one is refused before anything is fetched', linux, async () => {
  const { parsePins, DatasetPin } = await pinsMod();
  const { downloadDataset } = await dl();
  const pin = parsePins(pinsText()).dataset!;
  const Ctor = DatasetPin as unknown as new (...a: unknown[]) => unknown;
  assert.throws(() => new Ctor(Symbol('pins'), URL_AT_REV, REV, SHA, FILE, [HOST], 1024), /pins file/);
  const b = bench();
  const s = serving();
  const forged = { ...pin } as unknown as typeof pin;
  await assert.rejects(downloadDataset(b.layout, uid, forged, s.fetch), /pins file/);
  // Adversarial pass: one built on the class's prototype, past its constructor, passes instanceof; refused all the same.
  const proto = Object.assign(Object.create(DatasetPin.prototype) as object, { ...pin, url: 'https://data.example.org/other' }) as typeof pin;
  assert.ok(proto instanceof DatasetPin);
  await assert.rejects(downloadDataset(b.layout, uid, proto, s.fetch), /pins file/);
  assert.equal(s.calls.length, 0, 'nothing fetched');
  assert.ok(!existsSync(b.layout.root), 'nothing made');
});

test('adversarial pass: a parsed pin cannot be changed, and an escaped instance id is still refused', async () => {
  const { parsePins, pinnedImage } = await pinsMod();
  const pins = parsePins(pinsText({ digests: DIGESTS }));
  const extra = `sha256:${sha256('added after parsing')}`;
  assert.throws(() => (pins.digests as unknown as string[]).push(extra), TypeError);
  assert.throws(() => (pins.dataset as unknown as { sha256: string }).sha256 = SHA.replace(/^./, 'f'), TypeError);
  assert.throws(() => (pins.dataset!.hosts as string[]).push('elsewhere.example.net'), TypeError);
  assert.throws(() => pinnedImage(`swebench/example@${extra}`, pins), /not one of the pinned/);
  // `_` is `_`: the raw text has no `__`, the parsed path does.
  const escaped = pinsText({ path: 'data/django__django-11099.jsonl' }).replace('django__django', 'django\\u005f\\u005fdjango');
  assert.doesNotMatch(escaped, /__/);
  assert.throws(() => parsePins(escaped), /instance id/);
});

// ---- The dataset download ----

test('download: the pinned bytes land in the 0700 store as a 0600 file, through no temp file left behind', linux, async () => {
  const { parsePins } = await pinsMod();
  const { downloadDataset } = await dl();
  const pin = parsePins(pinsText()).dataset!;
  const b = bench();
  const s = serving();
  const r = await downloadDataset(b.layout, uid, pin, s.fetch);
  assert.deepEqual(s.calls, [URL_AT_REV], 'one request, at the pinned revision');
  assert.equal(r.fetched, true);
  assert.equal(r.file, join(b.layout.data, FILE));
  assert.deepEqual(readFileSync(r.file), DATA);
  assert.equal(mode(r.file), 0o600, 'the file is 0600');
  assert.equal(mode(b.layout.heldOut), 0o700, 'the store is 0700');
  assert.equal(mode(b.layout.data), 0o700, 'its dataset folder is 0700');
  assert.deepEqual(tree(b.layout.data), [FILE], 'no temp file left');
  // Again: the file is there and verified, so nothing is fetched.
  const again = await downloadDataset(b.layout, uid, pin, s.fetch);
  assert.equal(again.fetched, false);
  assert.equal(s.calls.length, 1, 'not fetched twice');
});

test('download: bytes that do not match the pinned sha256 write nothing, not even the store', linux, async () => {
  const { parsePins } = await pinsMod();
  const { downloadDataset } = await dl();
  const pin = parsePins(pinsText()).dataset!;
  const b = bench();
  const s = serving(Buffer.from('{"row": 1, "note": "tampered bytes"}\n'));
  await assert.rejects(downloadDataset(b.layout, uid, pin, s.fetch), /sha256/);
  assert.ok(!existsSync(b.layout.root), 'no bench root, no store, no temp file');
  // With the store already made: still nothing in it.
  mkdirSync(b.layout.heldOut, { recursive: true, mode: 0o700 });
  chmodSync(b.layout.heldOut, 0o700);
  await assert.rejects(downloadDataset(b.layout, uid, pin, s.fetch), /sha256/);
  assert.deepEqual(tree(b.layout.heldOut), [], 'nothing written into the store');
  // A connection cut after every byte arrived, and a file over the cap: nothing either.
  const cut = server({ [URL_AT_REV]: { status: 200, body: [DATA], cut: true } });
  await assert.rejects(downloadDataset(b.layout, uid, pin, cut.fetch), /reset/);
  const small = parsePins(pinsText({ max: 16 })).dataset!;
  await assert.rejects(downloadDataset(b.layout, uid, small, serving().fetch), /over|cap|bytes/);
  assert.deepEqual(tree(b.layout.heldOut), [], 'still nothing');
});

test('download: redirects only over https to a pinned host or its subdomain, at most five', linux, async () => {
  const { parsePins } = await pinsMod();
  const { downloadDataset } = await dl();
  const pin = parsePins(pinsText()).dataset!;
  const cdn = `https://cdn.${HOST}/blobs/abc`;
  const ok = server({ [URL_AT_REV]: { status: 302, location: cdn }, [cdn]: { status: 200, body: [DATA] } });
  const b = bench();
  assert.equal((await downloadDataset(b.layout, uid, pin, ok.fetch)).fetched, true);
  assert.deepEqual(ok.calls, [URL_AT_REV, cdn]);
  const refused: [string, Record<string, Route>][] = [
    ['another host', { [URL_AT_REV]: { status: 302, location: 'https://elsewhere.example.net/blob' } }],
    ['a host that only ends like the pinned one', { [URL_AT_REV]: { status: 302, location: `https://evil${HOST}/blob` } }],
    ['the pinned host as a subdomain of another', { [URL_AT_REV]: { status: 302, location: `https://${HOST}.elsewhere.example.net/blob` } }],
    ['backslashes for slashes', { [URL_AT_REV]: { status: 302, location: 'https:\\\\elsewhere.example.net\\blob' } }],
    ['the pinned host after an @', { [URL_AT_REV]: { status: 302, location: `https://elsewhere.example.net\\@${HOST}/blob` } }],
    ['plain http', { [URL_AT_REV]: { status: 301, location: `http://${HOST}/blob` } }],
    ['credentials', { [URL_AT_REV]: { status: 307, location: `https://u:p@${HOST}/blob` } }],
    ['a port', { [URL_AT_REV]: { status: 308, location: `https://${HOST}:444/blob` } }],
    ['no location', { [URL_AT_REV]: { status: 302 } }],
    ['a loop', { [URL_AT_REV]: { status: 302, location: URL_AT_REV } }],
    ['not found', {}],
    ['a 200 with no body', { [URL_AT_REV]: { status: 200 } }],
  ];
  for (const [why, routes] of refused) {
    const s = server(routes);
    const fresh = bench();
    await assert.rejects(downloadDataset(fresh.layout, uid, pin, s.fetch), Error, why);
    assert.ok(s.calls.every((u) => u === URL_AT_REV), `${why}: nothing fetched off the pinned host (${s.calls.join(', ')})`);
    assert.ok(s.calls.length <= 6, `${why}: at most five redirects`);
    assert.ok(!existsSync(fresh.layout.root), `${why}: nothing made`);
  }
});

test("download: a store that fails the preflight's held-out check is refused before anything is fetched", linux, async () => {
  const { parsePins } = await pinsMod();
  const { downloadDataset } = await dl();
  const pin = parsePins(pinsText()).dataset!;
  // Open to the group.
  const open = bench();
  mkdirSync(open.layout.heldOut, { recursive: true, mode: 0o700 });
  chmodSync(open.layout.heldOut, 0o750);
  const s1 = serving();
  await assert.rejects(downloadDataset(open.layout, uid, pin, s1.fetch), /0750.*0700/);
  assert.equal(s1.calls.length, 0, 'nothing fetched');
  assert.equal(mode(open.layout.heldOut), 0o750, 'never chmodded: the owner fixes it');
  assert.deepEqual(tree(open.layout.heldOut), []);
  // A linked parent: `state` points elsewhere.
  const linked = bench();
  const elsewhere = join(linked.base, 'elsewhere');
  mkdirSync(elsewhere, { mode: 0o700 });
  mkdirSync(linked.layout.root);
  symlinkSync(elsewhere, linked.layout.state);
  const s2 = serving();
  await assert.rejects(downloadDataset(linked.layout, uid, pin, s2.fetch), /link/);
  assert.equal(s2.calls.length, 0);
  assert.deepEqual(tree(elsewhere), [], 'nothing written where the link points');
  // The store itself a link.
  const l2 = bench();
  const e2 = join(l2.base, 'elsewhere');
  mkdirSync(e2, { mode: 0o700 });
  mkdirSync(join(l2.layout.heldOut, '..'), { recursive: true });
  symlinkSync(e2, l2.layout.heldOut);
  const s3 = serving();
  await assert.rejects(downloadDataset(l2.layout, uid, pin, s3.fetch), /link/);
  assert.equal(s3.calls.length, 0);
  assert.deepEqual(tree(e2), []);
});

test('download: never follows a link: not a linked dataset folder, not a link at the file name', linux, async () => {
  const { parsePins } = await pinsMod();
  const { downloadDataset } = await dl();
  const pin = parsePins(pinsText()).dataset!;
  // The dataset folder a link out of the store.
  const a = bench();
  mkdirSync(a.layout.heldOut, { recursive: true, mode: 0o700 });
  chmodSync(a.layout.heldOut, 0o700);
  const out = join(a.base, 'outside');
  mkdirSync(out, { mode: 0o700 });
  symlinkSync(out, a.layout.data);
  const s1 = serving();
  await assert.rejects(downloadDataset(a.layout, uid, pin, s1.fetch), /link/);
  assert.equal(s1.calls.length, 0);
  assert.deepEqual(tree(out), []);
  // The file name a link to a file outside the store.
  const b = bench();
  mkdirSync(b.layout.data, { recursive: true, mode: 0o700 });
  chmodSync(b.layout.heldOut, 0o700);
  chmodSync(b.layout.data, 0o700);
  const victim = join(b.base, 'victim.txt');
  writeFileSync(victim, 'keep me');
  symlinkSync(victim, join(b.layout.data, FILE));
  const s2 = serving();
  await assert.rejects(downloadDataset(b.layout, uid, pin, s2.fetch), /link/);
  assert.equal(readFileSync(victim, 'utf8'), 'keep me', 'the file the link names is untouched');
  assert.ok(lstatSync(join(b.layout.data, FILE)).isSymbolicLink(), 'the link is left for the owner to look at');
  assert.equal(s2.calls.length, 0);
  // A file already at the name whose bytes don't match: refused, left as it is, nothing fetched.
  const c = bench();
  mkdirSync(c.layout.data, { recursive: true, mode: 0o700 });
  chmodSync(c.layout.heldOut, 0o700);
  chmodSync(c.layout.data, 0o700);
  writeFileSync(join(c.layout.data, FILE), 'changed since', { mode: 0o600 });
  const s3 = serving();
  await assert.rejects(downloadDataset(c.layout, uid, pin, s3.fetch), /sha256/);
  assert.equal(readFileSync(join(c.layout.data, FILE), 'utf8'), 'changed since');
  assert.equal(s3.calls.length, 0);
});

// ---- Images ----

test('images: a reference is taken only with a pinned sha256 digest, never a tag', async () => {
  const { parsePins, pinnedImage } = await pinsMod();
  const pins = parsePins(pinsText({ digests: DIGESTS }));
  const hex = D.slice('sha256:'.length);
  assert.equal(String(pinnedImage(`swebench/example@${D}`, pins)), `swebench/example@${D}`);
  assert.equal(String(pinnedImage(`ghcr.io/org/example@${D}`, pins)), `ghcr.io/org/example@${D}`);
  const refused: [string, string][] = [
    ['swebench/example:latest', 'a tag only'],
    ['swebench/example', 'no digest'],
    [`swebench/example:latest@${D}`, 'a tag beside the digest'],
    [`swebench/Example@${D}`, 'upper case'],
    [`swebench/example@sha256:${hex.slice(1)}`, 'a short digest'],
    [`swebench/example@sha256:${hex.toUpperCase()}`, 'upper-case hex'],
    [`swebench/example@sha512:${hex}${hex}`, 'another algorithm'],
    [`localhost:5000/example@${D}`, 'a registry port'],
    [` swebench/example@${D}`, 'a space'],
    [`swebench/example@${D}\n`, 'a newline'],
    [`--platform=x@${D}`, 'an option'],
    [`swebench/example@sha256:${sha256('not pinned')}`, 'a digest not in the pins'],
  ];
  for (const [ref, why] of refused) assert.throws(() => pinnedImage(ref, pins), Error, why);
  // No digest pinned: no image at all.
  assert.throws(() => pinnedImage(`swebench/example@${D}`, parsePins(pinsText())), /pinned/);
});

/** A recording docker stand-in: every argv, and what it answers. */
function dockerStandIn(answer: (args: readonly string[]) => { status: number; stdout?: string; stderr?: string }) {
  const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const call: DockerCall = (_bin, args, o) => {
    calls.push({ args: [...args], env: o.env });
    const r = answer(args);
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };
  return { call, calls };
}

const dockerEnvFor = (base: string): NodeJS.ProcessEnv => ({ PATH: '/nonexistent', DOCKER_HOST: `unix://${base}/docker.sock`, SOME_SERVICE_TOKEN: 'canary-token-value-77' });

test('images: the only docker calls are `pull <ref@digest>` and `image inspect`, and the digest is read back', async () => {
  const { parsePins, pinnedImage } = await pinsMod();
  const { pullImage } = await dl();
  const pins = parsePins(pinsText({ digests: DIGESTS }));
  const ref = pinnedImage(`swebench/example@${D}`, pins);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'bench-img-')));
  const d = dockerStandIn((a) => (a[0] === 'pull' ? { status: 0 } : { status: 0, stdout: JSON.stringify([`swebench/example@${D}`]) }));
  pullImage({ docker: 'docker', env: dockerEnvFor(base), call: d.call }, ref);
  assert.deepEqual(
    d.calls.map((c) => c.args),
    [
      ['pull', `swebench/example@${D}`],
      ['image', 'inspect', '--format', '{{json .RepoDigests}}', `swebench/example@${D}`],
    ],
  );
  for (const c of d.calls) {
    assert.equal(c.env.DOCKER_HOST, `unix://${base}/docker.sock`, 'the bench user daemon, by an absolute DOCKER_HOST');
    assert.equal(c.env.SOME_SERVICE_TOKEN, undefined, 'no credential variable reaches docker');
  }
  // docker.io's short form reads back the same.
  const io = dockerStandIn((a) => (a[0] === 'pull' ? { status: 0 } : { status: 0, stdout: JSON.stringify([`swebench/example@${D}`]) }));
  pullImage({ docker: 'docker', env: dockerEnvFor(base), call: io.call }, pinnedImage(`docker.io/swebench/example@${D}`, pins));
  assert.equal(io.calls.length, 2);
});

test('images: a failed pull or a digest that does not read back refuses; a hand-made reference never reaches docker', async () => {
  const { parsePins, pinnedImage } = await pinsMod();
  const { pullImage, checkImageArgs } = await dl();
  const pins = parsePins(pinsText({ digests: DIGESTS }));
  const ref = pinnedImage(`swebench/example@${D}`, pins);
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'bench-img-')));
  const failed = dockerStandIn(() => ({ status: 1, stderr: 'manifest unknown' }));
  assert.throws(() => pullImage({ docker: 'docker', env: dockerEnvFor(base), call: failed.call }, ref), /pull/);
  assert.deepEqual(failed.calls.map((c) => c.args[0]), ['pull'], 'no inspect after a failed pull');
  const other = dockerStandIn((a) => (a[0] === 'pull' ? { status: 0 } : { status: 0, stdout: JSON.stringify([`swebench/example@${DIGESTS[8]}`]) }));
  assert.throws(() => pullImage({ docker: 'docker', env: dockerEnvFor(base), call: other.call }, ref), /digest/);
  const unreadable = dockerStandIn((a) => (a[0] === 'pull' ? { status: 0 } : { status: 0, stdout: 'not json' }));
  assert.throws(() => pullImage({ docker: 'docker', env: dockerEnvFor(base), call: unreadable.call }, ref), /digest/);
  // A plain string where a pinned reference belongs (a caller around the type).
  const forged = dockerStandIn(() => ({ status: 0 }));
  assert.throws(() => pullImage({ docker: 'docker', env: dockerEnvFor(base), call: forged.call }, 'swebench/example:latest' as unknown as typeof ref), /pins file/);
  assert.equal(forged.calls.length, 0, 'docker never asked');
  // The argv check itself, whatever builds the argv.
  const good = `swebench/example@${D}`;
  checkImageArgs(['pull', good]);
  checkImageArgs(['image', 'inspect', '--format', '{{json .RepoDigests}}', good]);
  for (const args of [
    ['pull', 'swebench/example:latest'],
    ['pull', 'swebench/example'],
    ['pull', '--platform', 'linux/amd64', good],
    ['pull', good, 'extra'],
    ['pull', '--all-tags', 'swebench/example'],
    ['image', 'inspect', good],
    ['image', 'inspect', '--format', '{{.Config}}', good],
    ['image', 'rm', good],
    ['run', good],
    ['tag', good, 'swebench/example:latest'],
  ]) assert.throws(() => checkImageArgs(args), Error, args.join(' '));
});

// ---- The bench command ----

/** The bench command's deps on a temp bench machine: the bench user, its home, a fetcher stand-in. */
function cliDeps(b: { home: string }, fetch: Fetcher, out: string[], over: Record<string, unknown> = {}) {
  const env: NodeJS.ProcessEnv = { PATH: '/nonexistent', HOME: b.home, [BENCH_USER_ENV]: currentUser() };
  return { env, user: currentUser(), uid, euid: process.geteuid?.() ?? uid, passwdHome: () => b.home, fetch, out: (l: string) => out.push(l), ...over };
}

test('bench download: the pinned dataset into the store, one PASS line; help names it', linux, async () => {
  const { parsePins } = await pinsMod();
  const { main, download } = await cli();
  const help: string[] = [];
  assert.equal(main(['help'], { out: (l: string) => help.push(l) }), 0);
  assert.match(help.join('\n'), /download/);
  const b = bench();
  const s = serving();
  const out: string[] = [];
  const code = await download(cliDeps(b, s.fetch, out) as never, () => parsePins(pinsText()));
  assert.equal(code, 0, out.join('\n'));
  assert.match(out.join('\n'), new RegExp(`PASS.*${SHA}.*${REV}`));
  assert.deepEqual(readFileSync(join(b.layout.data, FILE)), DATA);
});

test('bench download: no pin override, no other user, and an unpinned file fetches nothing', linux, async () => {
  const { loadPins, parsePins } = await pinsMod();
  const { main, download } = await cli();
  const b = bench();
  // An argument is refused: no flag sets a pin.
  const s0 = serving();
  const bad: string[] = [];
  assert.equal(await main(['download', '--sha256', SHA], cliDeps(b, s0.fetch, bad) as never), 2);
  assert.match(bad.join('\n'), /takes no arguments/);
  assert.equal(s0.calls.length, 0);
  // Another user: refused before the pins are read or anything fetched.
  const s1 = serving();
  const other: string[] = [];
  assert.equal(await download(cliDeps(b, s1.fetch, other, { user: 'someone-else' }) as never, () => parsePins(pinsText())), 1);
  assert.match(other.join('\n'), /FAIL/);
  assert.equal(s1.calls.length, 0);
  // Unpinned: refused, nothing fetched or made.
  const s2 = serving();
  const un: string[] = [];
  assert.equal(await download(cliDeps(b, s2.fetch, un) as never, () => parsePins(pinsText({ revision: null, sha256: null }))), 1);
  assert.match(un.join('\n'), /not pinned/);
  assert.equal(s2.calls.length, 0);
  assert.ok(!existsSync(b.layout.root));
  // The real command reads the repo's pins file: unpinned, it refuses the same way and fetches nothing; pinned, the
  // stand-in serves nothing at the real url, so it fails there, having written nothing.
  const s3 = serving();
  const real: string[] = [];
  const code = await main(['download'], cliDeps(b, s3.fetch, real) as never);
  assert.equal(code, 1, real.join('\n'));
  assert.ok(!existsSync(b.layout.heldOut), 'nothing in the store');
  assert.ok(s3.calls.every((u) => u.startsWith('https://')), 'only the stand-in was asked');
  if (!loadPins().dataset) assert.equal(s3.calls.length, 0, 'unpinned: nothing fetched');
});
