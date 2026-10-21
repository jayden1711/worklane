// The bench's task images (#748, slice 4): `bench images` writes the store's images file, each selected task's
// pinned image reference (`{"<instance id>": "<name>@sha256:<digest>"}`), which the run (select.ts loadTasks) reads.
//
// Where each part comes from, never from a command line or a hand-written file (the bench user's shell history is
// readable by the agents):
// - the tasks: the store's manifest, only when it is exactly what the pins select now (select.ts selectedTasks);
// - the name: the task's own, under SWE-bench's image naming (taskImageName): the IMAGE_NAMESPACE repository
//   IMAGE_PREFIX + the instance id in lower case with each `__` spelled as SWE-bench spells it. An id that naming
//   doesn't cover is refused;
// - the digest: the sha256 of the manifest the registry serves for that name's IMAGE_TAG (registryDigest), taken only
//   when it is one of pins.json's image_digests (imageRefFor). So the registry says which image is the task's, and the
//   pins say which images may be used at all: a tag moved to an image that isn't pinned is refused, never followed.
//   No two tasks may share a digest. `pullImage` (download.ts) reads the digest back for the name when it pulls.
//
// The registry: Docker Hub's, at fixed addresses (REGISTRY), asked for an anonymous pull token and then the tag's
// manifest, nothing else: no image layer is fetched, no credential is sent, no redirect is followed, and every answer
// is capped. Its messages name keys, never a task, and never quote the image name or a url.
//
// The file: written only once every task has its reference, after the store and the manifest are checked again (the
// lookups await), through select.ts writeOnce: a verified 0600 file of this user under a fresh name, linked to its
// name, never over anything. A different file already there is refused, never replaced: move it aside to write it
// again.
import { createHash } from 'node:crypto';
import { constants, fstatSync, lstatSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import type { BenchLayout } from './paths.js';
import { DIGEST, DIGEST_REF, pinnedImage, requirePinned, type ImageRef, type Pins } from './pins.js';
import { IMAGES_FILE, imageNamesTask, selectedTasks, writeOnce } from './select.js';
import { heldOutCheck } from './store.js';

/** SWE-bench's image naming: the Docker Hub repository `<IMAGE_NAMESPACE>/<IMAGE_PREFIX><id>`, at IMAGE_TAG. */
export const IMAGE_NAMESPACE = 'swebench';
export const IMAGE_PREFIX = 'sweb.eval.x86_64.';
export const IMAGE_TAG = 'latest';
/** The longest repository name the registry takes. */
const NAME_MAX = 255;

/** Docker Hub's registry: where the anonymous pull token comes from (and for which service), and the v2 API. */
export const REGISTRY = Object.freeze({ token: 'https://auth.docker.io/token', service: 'registry.docker.io', api: 'https://registry-1.docker.io/v2/' });
/** The manifest types asked for and taken: an image index or list, or one image's manifest. */
export const MANIFEST_TYPES: readonly string[] = Object.freeze(['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.docker.distribution.manifest.v2+json', 'application/vnd.oci.image.manifest.v1+json']);
/** The most a manifest, or a token answer, may hold. */
export const MANIFEST_MAX_BYTES = 4 * 2 ** 20;
const TOKEN_MAX_BYTES = 64 * 2 ** 10;
/** A bearer token that is safe in a header: no space, no line break. */
const TOKEN_SAFE = /^[A-Za-z0-9._~+/=-]{1,16384}$/;
/** An instance id SWE-bench's naming covers: `<owner>__<repo>-<number>`. */
const INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*__[A-Za-z0-9][A-Za-z0-9._-]*-\d+$/;

/** One registry answer: its status, its headers (names in lower case) and its body. */
export interface RegistryReply {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Buffer;
}

/** One GET to the registry, following no redirect, reading at most `maxBytes` (plus one) of the body. Tests pass a stand-in. */
export type RegistryFetch = (url: string, headers: Readonly<Record<string, string>>, maxBytes: number) => Promise<RegistryReply>;

/** Node's own fetch, one request, no redirect followed, only to REGISTRY's addresses. Not run by the tests (no network there). */
export const httpsRegistry: RegistryFetch = async (url, headers, maxBytes) => {
  if (!url.startsWith(`${REGISTRY.token}?`) && !url.startsWith(REGISTRY.api)) throw new Error('not a registry address');
  const r = await fetch(url, { headers: { ...headers }, redirect: 'manual', signal: AbortSignal.timeout(120_000) });
  const h: Record<string, string> = {};
  r.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
  const parts: Buffer[] = [];
  if (r.body) {
    const reader = r.body.getReader();
    try {
      for (let n = 0; n <= maxBytes; ) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.length;
        parts.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
  }
  return { status: r.status, headers: h, body: Buffer.concat(parts) };
};

const hex = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The task's image name under SWE-bench's naming: `<IMAGE_NAMESPACE>/<IMAGE_PREFIX>` and the instance id in lower case,
 * each `__` spelled as SWE-bench spells it. Refuses (throws, quoting nothing) an id that naming doesn't cover: not
 * `<owner>__<repo>-<number>`, or a name docker wouldn't take, or one the run's own check (select.ts imageNamesTask)
 * wouldn't take.
 */
export function taskImageName(instanceId: string): string {
  const refuse = () => new Error(`this task's instance id has no image name under SWE-bench's naming (${IMAGE_NAMESPACE}/${IMAGE_PREFIX}<owner>, <repo> and <number>, in lower case): refused, nothing asked`);
  if (typeof instanceId !== 'string' || !INSTANCE_ID.test(instanceId)) throw refuse();
  const name = `${IMAGE_NAMESPACE}/${IMAGE_PREFIX}${instanceId.toLowerCase().split('__').join('_1776_')}`;
  if (name.length > NAME_MAX || !DIGEST_REF.test(`${name}@sha256:${'0'.repeat(64)}`) || !imageNamesTask(name, instanceId)) throw refuse();
  return name;
}

/** One request through `fetch`; a failure says only which request and an error code, never the url (it names the task). */
async function ask(fetch: RegistryFetch, url: string, headers: Record<string, string>, max: number, what: string): Promise<RegistryReply> {
  let r: RegistryReply;
  try {
    r = await fetch(url, Object.freeze(headers), max);
  } catch (e) {
    const err = e as { code?: unknown; cause?: { code?: unknown } } | null;
    const code = err?.code ?? err?.cause?.code;
    throw new Error(`the registry's ${what} failed${typeof code === 'string' && /^[A-Z][A-Z_]{0,39}$/.test(code) ? ` (${code})` : ''}: refused`);
  }
  if (r.status !== 200) throw new Error(`the registry's ${what} answered HTTP ${Number(r.status) || 0}: refused (no redirect is followed)`);
  if (!Buffer.isBuffer(r.body) || r.body.length > max) throw new Error(`the registry's ${what} answered over ${max} bytes: refused`);
  return r;
}

/** The parsed JSON object in `body`, or null. */
function jsonObject(body: Buffer): Record<string, unknown> | null {
  try {
    const o: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    return typeof o === 'object' && o !== null && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The digest of the manifest the registry serves for image `name` at IMAGE_TAG: `sha256:` and the sha256 of the
 * manifest's own bytes (never only a header's word for it). Refuses (throws) a name outside IMAGE_NAMESPACE, any status
 * but 200, a body over the cap, a manifest of another type, not JSON or not schema version 2, and a digest header that
 * isn't the body's. Its messages never quote the name.
 */
export async function registryDigest(name: string, fetch: RegistryFetch): Promise<string> {
  if (typeof name !== 'string' || !name.startsWith(`${IMAGE_NAMESPACE}/`) || name.length > NAME_MAX || !DIGEST_REF.test(`${name}@sha256:${'0'.repeat(64)}`)) {
    throw new Error(`not an image name under ${IMAGE_NAMESPACE}/: refused before any request`);
  }
  const tokenUrl = `${REGISTRY.token}?service=${encodeURIComponent(REGISTRY.service)}&scope=${encodeURIComponent(`repository:${name}:pull`)}`;
  const t = jsonObject((await ask(fetch, tokenUrl, {}, TOKEN_MAX_BYTES, 'token request')).body);
  const token = t?.token ?? t?.access_token;
  if (typeof token !== 'string' || !TOKEN_SAFE.test(token)) throw new Error("the registry's token answer holds no usable token: refused");
  const m = await ask(fetch, `${REGISTRY.api}${name}/manifests/${IMAGE_TAG}`, { accept: MANIFEST_TYPES.join(', '), authorization: `Bearer ${token}` }, MANIFEST_MAX_BYTES, 'manifest request');
  const type = (m.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (!MANIFEST_TYPES.includes(type)) throw new Error("the registry's answer is not an image manifest of a type this takes (its content type): refused");
  const o = jsonObject(m.body);
  if (!o || o.schemaVersion !== 2 || (o.mediaType !== undefined && o.mediaType !== type)) throw new Error("the registry's manifest is not a schema 2 manifest of its own content type: refused");
  const digest = `sha256:${hex(m.body)}`;
  const said = m.headers['docker-content-digest'];
  if (said !== undefined && said !== digest) throw new Error(`the registry's digest header is not the manifest's own sha256 (${digest}): refused`);
  return digest;
}

/**
 * The task's image reference: `name` at `digest`, taken only when the name is the task's own (select.ts
 * imageNamesTask), the digest one of the pinned image_digests (pins.ts pinnedImage), and no task in `seen` (digest to
 * key) has that digest. Records it in `seen`. Refuses (throws) otherwise; its messages name keys and digests only.
 */
export function imageRefFor(task: { key: string; instanceId: string }, name: string, digest: string, pins: Pins, seen: Map<string, string>): ImageRef {
  requirePinned(pins, 'set of pins');
  if (!imageNamesTask(name, task.instanceId)) throw new Error(`${task.key}: its image's name is not this task's (SWE-bench names a task's image after its instance id): refused, nothing written`);
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new Error(`${task.key}: the registry's digest for this task's image is not a sha256 digest: refused, nothing written`);
  if (!pins.digests.includes(digest)) throw new Error(`${task.key}: the registry serves ${digest} for this task's image, which is not one of the pinned image_digests (scripts/bench/pins.json): refused, nothing written`);
  let ref: ImageRef;
  try {
    ref = pinnedImage(`${name}@${digest}`, pins);
  } catch {
    // pinnedImage's own message quotes the reference, which names the task: never passed on.
    throw new Error(`${task.key}: its image reference is refused: only <name>@sha256:<digest>, with the digest one of the pinned image_digests; nothing written`);
  }
  const other = seen.get(digest);
  if (other !== undefined) throw new Error(`${task.key}: the registry serves ${other}'s image digest for this task too: each task has its own image; refused, nothing written`);
  seen.set(digest, task.key);
  return ref;
}

/** What `bench images` did: keys, the count and the file's sha256, never an instance id or an image name. */
export interface ImagesSummary {
  keys: readonly string[];
  /** The sha256 of the images file's text. */
  sha256: string;
  /** false: the same file was already there, and was kept. */
  written: boolean;
}

/** Refuses (throws) a link at `f`, or anything there but a 0600 regular file of `uid`; nothing there is fine. Reads nothing. */
function refuseOddFile(f: string, uid: number): void {
  let st;
  try {
    st = lstatSync(f);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error(`${f} is a link: refused (never followed), nothing asked; look at it, then move it aside`);
  const fd = openSync(f, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.uid !== uid || (s.mode & 0o7777) !== 0o600) throw new Error(`${f} is not a 0600 file of this user: refused, nothing asked; look at it, then move it aside`);
  } finally {
    closeSync(fd);
  }
}

/**
 * `bench images`: every selected task's image reference into the store's images file, as the top of this file says.
 * Refuses (throws), writing nothing, when anything is in doubt: the pins, the store, the manifest, a task's naming,
 * any registry answer, a digest not pinned, two tasks with one digest, or a file already at the images file's name
 * that is a link or holds anything else.
 */
export async function writeImages(layout: BenchLayout, uid: number, pins: Pins, fetch: RegistryFetch): Promise<ImagesSummary> {
  requirePinned(pins, 'set of pins');
  if (!pins.digests.length) throw new Error('no image digest is pinned yet (image_digests in scripts/bench/pins.json is empty): nothing asked, nothing written');
  const tasks = selectedTasks(layout, uid, pins);
  const f = join(layout.heldOut, IMAGES_FILE);
  refuseOddFile(f, uid);
  // Every name first: an id the naming doesn't cover refuses the whole file before any request.
  const named = tasks.map((t) => {
    try {
      return { key: t.key, instanceId: t.row.instance_id, name: taskImageName(t.row.instance_id) };
    } catch (e) {
      throw new Error(`${t.key}: ${message(e)}`);
    }
  });
  const seen = new Map<string, string>();
  const refs: [string, string][] = [];
  for (const t of named) {
    let digest: string;
    try {
      digest = await registryDigest(t.name, fetch);
    } catch (e) {
      throw new Error(`${t.key}: ${message(e)}; nothing written`);
    }
    const ref = imageRefFor(t, t.name, digest, pins, seen);
    refs.push([t.instanceId, `${ref.name}@${ref.digest}`]);
  }
  // Checked again after the lookups' awaits: the store, and the manifest still exactly what the pins select.
  const again = selectedTasks(layout, uid, pins);
  if (again.length !== tasks.length || again.some((t, i) => t.key !== tasks[i]!.key || t.row.instance_id !== tasks[i]!.row.instance_id)) {
    throw new Error("the store's manifest changed while bench images ran: refused, nothing written");
  }
  const text = `${JSON.stringify(Object.fromEntries(refs), null, 2)}\n`;
  const written = writeOnce(layout, uid, IMAGES_FILE, text, { what: 'images file', why: "the run takes each task's image from it, so it is never replaced", again: 'write it again', command: 'bench images' });
  heldOutCheck(layout, uid);
  return { keys: Object.freeze(named.map((t) => t.key)), sha256: hex(text), written };
}
