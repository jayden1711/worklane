#!/usr/bin/env node
// New runtime dependencies are named in the pull request, with their licence and why (.github/workflows/new-deps.yml
// runs this on every PR; test/ci-new-deps.test.ts). It compares the PR's base and head:
//   - package.json `dependencies`, `optionalDependencies` and `peerDependencies`: a name added, or its spec changed;
//   - package-lock.json's runtime packages (every entry under node_modules/ without `dev: true`; devOptional counts as
//     runtime, it is installed in production): a name@version the base doesn't have, so transitive additions, a dev
//     package that became a runtime one, and version changes all count.
// Each such package must have a line in the PR body's "## New dependencies" section:
//   - <name> | <licence> | <why>
// the licence equal to the lockfile's `license` for every new version of it (case and outer parentheses aside), the
// reason not empty. Removals, and devDependencies / dev-only lockfile entries, need nothing. A package with no
// `license` in the lockfile fails: nothing to check the line against. Passing this is not approval: a new runtime
// dependency still waits for the owner's OK before it merges.
//   node scripts/ci/new-deps.mjs <base rev> <head rev> [--body-file <file>]
// reads both revisions' files with git show (data only, nothing from them runs) and the PR body from --body-file, or
// else from the event payload at $GITHUB_EVENT_PATH (pull_request.body). Exit 1 with each problem when any.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SPEC_FIELDS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/** The package name a lockfile path names: what follows its last node_modules/. */
const nameOf = (path, entry) => entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);

/** The lockfile's runtime packages: name@version -> { name, version, license }. Dev-only, links and the root aside. */
export function runtimePackages(lock) {
  const out = new Map();
  if (!lock) return out;
  if (!lock.packages || typeof lock.packages !== 'object') throw new Error('package-lock.json has no "packages" (lockfileVersion 2 or later is needed)');
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path.includes('node_modules/') || !entry || entry.dev === true || entry.link === true) continue;
    const name = nameOf(path, entry);
    const version = String(entry.version ?? '');
    out.set(`${name}@${version}`, { name, version, license: typeof entry.license === 'string' ? entry.license : null });
  }
  return out;
}

/** package.json's runtime specs added or changed: [{ field, name, from, to }]. */
export function specChanges(basePkg, headPkg) {
  const out = [];
  for (const field of SPEC_FIELDS) {
    const before = basePkg?.[field] ?? {};
    const after = headPkg?.[field] ?? {};
    for (const [name, to] of Object.entries(after)) if (before[name] !== to) out.push({ field, name, from: before[name] ?? null, to });
  }
  return out;
}

const normLicence = (s) => s.trim().replace(/\s+/g, ' ').replace(/^\((.*)\)$/, '$1').toLowerCase();
const stripTicks = (s) => s.trim().replace(/^`(.*)`$/, '$1').trim();
/** A name as a PR line may write it: `name`, name@1.2.3 or @scope/name@^1 (the version is ignored). */
const bareName = (s) => {
  const n = stripTicks(s);
  const at = n.indexOf('@', 1);
  return at > 0 ? n.slice(0, at) : n;
};

/** The PR body's "## New dependencies" section: { found, lines: Map<name, [{ licence, reason }]>, problems }. */
export function parseSection(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{2,6}\s*New dependencies\s*#*\s*$/i.test(l.trim()));
  const out = { found: start >= 0, lines: new Map(), problems: [] };
  if (start < 0) return out;
  for (const raw of lines.slice(start + 1)) {
    const l = raw.trim();
    if (/^#{1,6}\s/.test(l)) break;
    const m = /^[-*]\s+(.*)$/.exec(l);
    if (!m) continue;
    const parts = m[1].split('|').map((p) => p.trim());
    if (parts.length < 3) {
      out.problems.push(`"${l}": a line is "- <name> | <licence> | <why>"`);
      continue;
    }
    const [name, licence, ...why] = parts;
    const reason = why.join('|').trim();
    const n = bareName(name);
    if (!n) {
      out.problems.push(`"${l}": no package name`);
      continue;
    }
    if (!stripTicks(licence)) out.problems.push(`${n}: no licence on its line`);
    if (!reason) out.problems.push(`${n}: no reason on its line (why it is needed)`);
    out.lines.set(n, [...(out.lines.get(n) ?? []), { licence: stripTicks(licence), reason }]);
  }
  return out;
}

/**
 * What the PR changes in its runtime dependencies, and what is wrong with how its body names them.
 * Returns { changed: [{ name, versions, licences }], problems: string[] }.
 */
export function check({ basePkg, headPkg, baseLock, headLock, body }) {
  const problems = [];
  const before = runtimePackages(baseLock);
  const after = runtimePackages(headLock);
  /** name -> { versions:Set, licences:Set (null when the lockfile has none), why:string[] } */
  const changed = new Map();
  const note = (name) => {
    if (!changed.has(name)) changed.set(name, { versions: new Set(), licences: new Set(), why: [] });
    return changed.get(name);
  };
  for (const [key, p] of after) {
    if (before.has(key)) continue;
    const c = note(p.name);
    c.versions.add(p.version);
    c.licences.add(p.license);
    c.why.push(`${key} is new to the lockfile's runtime packages`);
  }
  for (const s of specChanges(basePkg, headPkg)) {
    const c = note(s.name);
    c.why.push(s.from === null ? `package.json ${s.field} adds it (${s.to})` : `package.json ${s.field} changes it (${s.from} -> ${s.to})`);
    const entry = headLock?.packages?.[`node_modules/${s.name}`];
    if (!entry) problems.push(`${s.name}: package.json ${s.field} names it but package-lock.json has no node_modules/${s.name} (run npm install and commit the lockfile)`);
    else if (!c.versions.size) {
      c.versions.add(String(entry.version ?? ''));
      c.licences.add(typeof entry.license === 'string' ? entry.license : null);
    }
  }
  if (!changed.size) return { changed: [], problems };

  const section = parseSection(body);
  if (!section.found) {
    problems.push(`the PR adds or changes ${changed.size} runtime package(s) and its body has no "## New dependencies" section. Add one, a line per package:\n## New dependencies\n${[...changed].map(([n, c]) => `- ${n} | ${[...c.licences].filter(Boolean).join(' / ') || '<licence>'} | <why it is needed>`).join('\n')}`);
  } else {
    problems.push(...section.problems);
    for (const [name, c] of changed) {
      const said = section.lines.get(name);
      if (!said) {
        problems.push(`${name}: not named in "## New dependencies" (${c.why.join('; ')})`);
        continue;
      }
      const saidLicences = new Set(said.map((x) => normLicence(x.licence)).filter(Boolean));
      for (const lic of c.licences) {
        if (lic === null) problems.push(`${name}: package-lock.json has no license for it, so its line can't be checked; the owner decides`);
        else if (!saidLicences.has(normLicence(lic))) problems.push(`${name}: the body says ${said.map((x) => `"${x.licence}"`).join(', ')}, the lockfile says "${lic}"`);
      }
    }
  }
  return { changed: [...changed].map(([name, c]) => ({ name, versions: [...c.versions], licences: [...c.licences], why: c.why })), problems };
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
/** A JSON file at a revision; null when the revision doesn't have it. */
function jsonAt(rev, path) {
  let text;
  try {
    text = execFileSync('git', ['show', `${rev}:${path}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    git('rev-parse', '--verify', '--quiet', `${rev}^{commit}`); // a bad revision fails loudly; a missing file is null
    return null;
  }
  return JSON.parse(text);
}

function main(argv) {
  const args = [...argv];
  let bodyFile = null;
  const i = args.indexOf('--body-file');
  if (i >= 0) [, bodyFile] = args.splice(i, 2);
  const [base, head] = args;
  if (!base || !head) {
    console.error('usage: node scripts/ci/new-deps.mjs <base rev> <head rev> [--body-file <file>]');
    return 2;
  }
  let body;
  if (bodyFile) body = readFileSync(bodyFile, 'utf8');
  else if (process.env.GITHUB_EVENT_PATH) body = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request?.body ?? '';
  else {
    console.error('no PR body: pass --body-file, or run on a pull_request event ($GITHUB_EVENT_PATH)');
    return 2;
  }
  const headLock = jsonAt(head, 'package-lock.json');
  if (!headLock) {
    console.error(`${head} has no package-lock.json`);
    return 1;
  }
  const r = check({ basePkg: jsonAt(base, 'package.json'), headPkg: jsonAt(head, 'package.json'), baseLock: jsonAt(base, 'package-lock.json'), headLock, body });
  for (const c of r.changed) console.log(`runtime package: ${c.name} ${c.versions.join(', ')} (${c.licences.map((l) => l ?? 'no licence').join(', ')}): ${c.why.join('; ')}`);
  if (!r.changed.length) console.log('no runtime dependency added or changed');
  for (const p of r.problems) console.error(`new-deps: ${p}`);
  if (r.problems.length) return 1;
  if (r.changed.length) console.log('every one is named with its licence and why; a new runtime dependency still needs the owner\'s OK to merge');
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main(process.argv.slice(2)));
