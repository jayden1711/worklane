// The bench's pins (#748, slice 2): the dataset's revision and sha256, and the image digests the bench may pull, in
// one data file, scripts/bench/pins.json. loadPins() reads that file and nothing else: no variable, flag or argument
// sets a pin. A pin exists only as parsePins() made it: DatasetPin, Pins and ImageRef refuse to be built anywhere else
// (a module-private token), are frozen once built, and the download and the pull refuse anything this module didn't
// build (requirePinned: a module-private WeakSet, which a copy or an object made on the class's prototype isn't in).
//
// What the file may hold, and only that (a closed schema: an unknown key refuses the whole file, and so does any text
// but the canonical form, JSON.stringify(pins, null, 2) and a newline, so a repeated key can't hide an unchecked copy):
// - dataset.base: an https url with no credentials, port, query or fragment, on one of dataset.hosts, ending in `/`,
//   written exactly as the url it is, each path segment a plain name (no percent escape);
//   dataset.path: a relative file path; the url fetched is base + revision + "/" + path, so it is at the pinned
//   revision by construction;
// - dataset.revision (a 40-hex commit) and dataset.sha256 (64 hex, of the file's bytes): both set, or both null
//   (unpinned: `bench download` refuses until the owner records them);
// - dataset.max_bytes, the most the download reads; dataset.hosts, where it may be redirected (a host or its
//   subdomains), https only;
// - image_digests: sha256 digests, sorted, each once; none, or at least MIN_DIGEST_SET of them;
// - selection (#748, slice 3): how the tasks are chosen, never which: `rule` (one of SELECTION_RULES, each a fixed
//   algorithm in select.ts), `seed` (a whole number, 0 to 2^32 - 1) and `rows_sha256` (the canonical digest of the rows
//   the rule reads, select.ts canonicalRows; null until the owner records it). Or null: nothing is selected. With the
//   dataset's revision, that is the whole selection: the same pins always choose the same tasks.
//
// What it must never hold: an instance id, an image name or a task selection. The bench user's clone is readable by
// the agents (only credential places, state and the held-out store are denied), so anything here that maps a task to
// its upstream PR would hand them the key the store keeps hidden. Image names carry the instance id, so the file holds
// digests only, as a set larger than any selection the bench makes (smoke 4, baseline 50); which image a task uses
// comes from the held-out store. A text that looks like an instance id or an instance image name refuses the file.
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The one pins file: scripts/bench/pins.json in this clone (this module runs from dist/scripts/bench/). */
export const PINS_FILE = fileURLToPath(new URL('../../../scripts/bench/pins.json', import.meta.url));

/** The fewest digests image_digests may hold when it holds any: more than any selection the bench makes. */
export const MIN_DIGEST_SET = 100;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** An image digest: sha256 only, lower-case hex. */
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const PATH_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A SWE-bench instance id (owner__repo-1234) or an instance image name (owner_1776_repo-1234). */
export const TASK_SHAPE = /[A-Za-z0-9.-]__[A-Za-z0-9_.-]+-\d+|_1776_/;
/** An image name component, and a registry domain (it has a dot; no port). */
const COMPONENT = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const DOMAIN = '[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+';
/** An image reference by digest and nothing else: no tag, no port, no option. */
export const DIGEST_REF = new RegExp(`^(?:${DOMAIN}/)?${COMPONENT}(?:/${COMPONENT})*@sha256:[0-9a-f]{64}$`);

/** Only this module builds a pin. */
const TOKEN: unique symbol = Symbol('pins');
/** Every pin this module built: one made on a class's prototype, past its constructor, passes instanceof, not this. */
const BUILT = new WeakSet<object>();
const NOT_PINNED = 'a pin comes only from the pins file (scripts/bench/pins.json, through parsePins)';
const fromPinsFile = (token: symbol, pin: object): void => {
  if (token !== TOKEN) throw new Error(NOT_PINNED);
  Object.freeze(pin);
  BUILT.add(pin);
};

/** Refuses (throws) anything this module didn't build from the pins file. */
export function requirePinned(x: unknown, what = 'pin'): void {
  if (typeof x !== 'object' || x === null || !BUILT.has(x)) throw new Error(`this ${what} is refused: ${NOT_PINNED}`);
}

/** The dataset's pin: the url at the pinned revision, the file's sha256, and where it may be fetched from. */
export class DatasetPin {
  constructor(
    token: symbol,
    /** base + revision + "/" + path. */
    readonly url: string,
    readonly revision: string,
    readonly sha256: string,
    /** Its name in the store's dataset folder: <sha256>-<the path's file name>. */
    readonly file: string,
    /** The hosts a redirect may lead to (each, or a subdomain of it), https only. */
    readonly hosts: readonly string[],
    readonly maxBytes: number,
  ) {
    fromPinsFile(token, this);
  }
}

/** The selection rules select.ts implements. A rule's algorithm never changes; a new one gets a new name. */
export const SELECTION_RULES = ['sha256-rank-v1'] as const;
export type SelectionRule = (typeof SELECTION_RULES)[number];
/** The largest seed: 32 bits. */
export const SEED_MAX = 2 ** 32 - 1;

/** How the tasks are chosen: the rule, its seed, and the canonical digest of the rows it reads (null until pinned). */
export class SelectionPin {
  constructor(
    token: symbol,
    readonly rule: SelectionRule,
    readonly seed: number,
    readonly rowsSha256: string | null,
  ) {
    fromPinsFile(token, this);
  }
}

/** Every pin in the file: the dataset's (null until pinned), the image digests (frozen, sorted) and the selection. */
export class Pins {
  constructor(
    token: symbol,
    readonly dataset: DatasetPin | null,
    readonly digests: readonly string[],
    readonly selection: SelectionPin | null,
  ) {
    fromPinsFile(token, this);
  }
}

/** An image by a pinned digest: `<name>@sha256:<64 hex>`, never a tag. Only pinnedImage() makes one. */
export class ImageRef {
  constructor(
    token: symbol,
    readonly name: string,
    readonly digest: string,
  ) {
    fromPinsFile(token, this);
  }

  toString(): string {
    return `${this.name}@${this.digest}`;
  }
}

// #863 round 1: a pin's behaviour can't be swapped either (download.ts reads only a pin's own frozen fields anyway).
for (const C of [DatasetPin, Pins, ImageRef, SelectionPin]) Object.freeze(C.prototype);

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(o: Record<string, unknown>, keys: readonly string[], where: string): void {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`pins: ${where} has an unknown key ${JSON.stringify(k).slice(0, 60)}: the pins file holds pins only`);
  for (const k of keys) if (!(k in o)) throw new Error(`pins: ${where} has no ${k}`);
}

const hostAllowed = (host: string, hosts: readonly string[]): boolean => hosts.some((h) => host === h || host.endsWith(`.${h}`));

/**
 * The https url `u`, refused (throws) unless it has no credentials, no port, no fragment, and a host in `hosts` (or a
 * subdomain of one). Exported for the download's redirects.
 */
export function checkUrl(u: string, hosts: readonly string[], where = 'url'): URL {
  let url: URL;
  try {
    url = new URL(u);
  } catch {
    throw new Error(`${where} is not a url`);
  }
  if (url.protocol !== 'https:') throw new Error(`${where} is ${url.protocol.replace(/:$/, '')}, not https`);
  if (url.username || url.password) throw new Error(`${where} carries credentials`);
  if (url.port) throw new Error(`${where} names a port`);
  if (url.hash) throw new Error(`${where} has a fragment`);
  if (!hostAllowed(url.hostname, hosts)) throw new Error(`${where} is on ${url.hostname}, not a pinned host (${hosts.join(', ')})`);
  return url;
}

function datasetPin(d: unknown): DatasetPin | null {
  if (!isObject(d)) throw new Error('pins: dataset is not an object');
  onlyKeys(d, ['base', 'path', 'revision', 'sha256', 'max_bytes', 'hosts'], 'dataset');
  const { base, path, revision, sha256, max_bytes: max, hosts } = d;
  if (!Array.isArray(hosts) || !hosts.length || !hosts.every((h) => typeof h === 'string' && HOSTNAME.test(h))) throw new Error('pins: dataset.hosts must list one or more host names');
  if (typeof base !== 'string' || !base.endsWith('/')) throw new Error('pins: dataset.base must be a url ending in /');
  const u = checkUrl(base, hosts as string[], 'pins: dataset.base');
  if (u.search) throw new Error('pins: dataset.base has a query');
  // #863 round 1: the url exactly as it is read (no default port, no dot segment, no upper-case host), and each path
  // segment a plain name, as dataset.path's are: no percent escape can spell anything the scan above would refuse.
  if (base !== u.href) throw new Error(`pins: dataset.base must be written as the url it is (${u.href})`);
  if (!u.pathname.split('/').slice(1, -1).every((p) => PATH_PART.test(p))) throw new Error('pins: dataset.base has a path segment that is not a plain name (no percent escape, no dot or empty segment)');
  if (typeof path !== 'string' || !path.split('/').every((p) => PATH_PART.test(p))) throw new Error('pins: dataset.path must be a relative file path (no .., no leading /)');
  if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > 2 ** 31) throw new Error('pins: dataset.max_bytes must be a whole number of bytes, at least 1');
  if (revision === null && sha256 === null) return null;
  if (typeof revision !== 'string' || !HEX40.test(revision)) throw new Error('pins: dataset.revision must be a 40-hex commit (lower case), or null with sha256 null');
  if (typeof sha256 !== 'string' || !HEX64.test(sha256)) throw new Error("pins: dataset.sha256 must be the file's sha256 (64 lower-case hex), or null with revision null");
  return new DatasetPin(TOKEN, `${base}${revision}/${path}`, revision, sha256, `${sha256}-${posix.basename(path)}`, Object.freeze([...(hosts as string[])]), max as number);
}

function digestSet(v: unknown): readonly string[] {
  if (!Array.isArray(v)) throw new Error('pins: image_digests must be a list');
  for (const [i, x] of v.entries()) {
    if (typeof x !== 'string' || !DIGEST.test(x)) throw new Error(`pins: image_digests[${i}] is not a sha256 digest (sha256:<64 lower-case hex>)`);
    if (i > 0 && !(x > (v[i - 1] as string))) throw new Error(`pins: image_digests must be sorted, each once (at ${i})`);
  }
  if (v.length > 0 && v.length < MIN_DIGEST_SET) throw new Error(`pins: image_digests holds ${v.length} digests: none, or at least ${MIN_DIGEST_SET} (a set larger than any selection, never the tasks a run uses)`);
  return Object.freeze([...(v as string[])]);
}

function selectionPin(s: unknown): SelectionPin | null {
  if (s === null) return null;
  if (!isObject(s)) throw new Error('pins: selection is not an object (or null: nothing selected)');
  onlyKeys(s, ['rule', 'seed', 'rows_sha256'], 'selection');
  const { rule, seed, rows_sha256: rows } = s;
  if (typeof rule !== 'string' || !(SELECTION_RULES as readonly string[]).includes(rule)) throw new Error(`pins: selection.rule must be one of ${SELECTION_RULES.join(', ')}`);
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 0 || seed > SEED_MAX) throw new Error(`pins: selection.seed must be a whole number from 0 to ${SEED_MAX}`);
  if (rows !== null && (typeof rows !== 'string' || !HEX64.test(rows))) throw new Error("pins: selection.rows_sha256 must be the rows' canonical sha256 (64 lower-case hex), or null until it is recorded");
  return new SelectionPin(TOKEN, rule as SelectionRule, seed, rows as string | null);
}

const TASK_REFUSED = 'pins: the file holds something shaped like an instance id or an instance image name: never in the repo (the agents can read it)';

/** The pins in `text` (a pins file), refused (throws) on anything the schema above doesn't allow. */
export function parsePins(text: string): Pins {
  if (TASK_SHAPE.test(text)) throw new Error(TASK_REFUSED);
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    throw new Error('pins: not JSON');
  }
  // Again on what the text means: a JSON escape (_ is `_`) hides a shape from the raw text, not from this.
  if (TASK_SHAPE.test(JSON.stringify(o))) throw new Error(TASK_REFUSED);
  // #863 round 1: the text must be exactly its canonical form, so every byte of it is what was parsed and checked:
  // a repeated key (JSON.parse keeps the last copy, unchecked earlier ones) or any other spelling is refused.
  if (text !== `${JSON.stringify(o, null, 2)}\n`) throw new Error('pins: the file is not in its canonical form (JSON.stringify(pins, null, 2) and a newline: no repeated key, no other spacing)');
  if (!isObject(o)) throw new Error('pins: not an object');
  onlyKeys(o, ['dataset', 'image_digests', 'selection'], 'the file');
  return new Pins(TOKEN, datasetPin(o.dataset), digestSet(o.image_digests), selectionPin(o.selection));
}

/** The pins, from the one pins file. */
export function loadPins(): Pins {
  return parsePins(readFileSync(PINS_FILE, 'utf8'));
}

/**
 * `ref` as an image to pull: `<name>@sha256:<64 hex>` with no tag, no port and no option, and its digest one of the
 * pins' image digests. Refused (throws) otherwise, and always while no digest is pinned.
 */
export function pinnedImage(ref: string, pins: Pins): ImageRef {
  requirePinned(pins, 'set of pins');
  if (typeof ref !== 'string' || !DIGEST_REF.test(ref)) throw new Error(`image ${JSON.stringify(ref).slice(0, 200)} refused: only <name>@sha256:<64 hex>, never a tag`);
  const at = ref.lastIndexOf('@');
  const name = ref.slice(0, at);
  const digest = ref.slice(at + 1);
  if (!pins.digests.includes(digest)) throw new Error(`image digest ${digest} refused: not one of the pinned image digests${pins.digests.length ? '' : ' (none is pinned yet)'}`);
  return new ImageRef(TOKEN, name, digest);
}
