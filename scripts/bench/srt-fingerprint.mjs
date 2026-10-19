#!/usr/bin/env node
// How close a sandbox-runtime release is to the build a Claude Code binary bundles (#748). Read-only: it executes
// neither. It compares the ASCII "[Sandbox Linux] ..." log strings of the release's dist/sandbox/*.js with those in
// the binary (a non-ASCII character ends a string: the binary may store those in another encoding). An exact match
// has nothing on either side; the bench's probe uses the closest release (probe.ts SRT_VERSION) until one matches.
//
// Usage: node scripts/bench/srt-fingerprint.mjs <unpacked sandbox-runtime package dir> <claude binary>
//   e.g. after `npm pack @anthropic-ai/sandbox-runtime@0.0.81` and `tar -xzf` into an empty folder of its own:
//   node scripts/bench/srt-fingerprint.mjs ./package ~/.local/share/claude/versions/2.1.303
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [dir, bin] = process.argv.slice(2);
if (!dir || !bin) {
  console.error('usage: srt-fingerprint.mjs <sandbox-runtime package dir> <claude binary>');
  process.exit(2);
}
const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
const pick = (text) => new Set([...text.matchAll(/\[Sandbox Linux\][ -!#%-&(-[\]-_a-~]{12,50}/g)].map((m) => m[0]));
const sandboxDir = join(dir, 'dist', 'sandbox');
const src = readdirSync(sandboxDir)
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(join(sandboxDir, f), 'utf8'))
  .join('\n');
const blob = readFileSync(bin).toString('latin1');
const release = pick(src);
const onlyRelease = [...release].filter((x) => !blob.includes(x));
// What the binary has and the release lacks. A string table can glue a byte or two onto a string's end, so a short
// tail after a release string's full text is not a difference.
const onlyBinary = [...pick(blob)].filter((x) => !src.includes(x) && ![...release].some((r) => x.startsWith(r)));
console.log(`sandbox-runtime ${version}: ${release.size} log strings, ${release.size - onlyRelease.length} in the binary`);
for (const x of onlyRelease) console.log(`  release only: ${x}`);
for (const x of onlyBinary) console.log(`  binary only:  ${x}`);
console.log(onlyRelease.length || onlyBinary.length ? `differs: ${onlyRelease.length} release-only, ${onlyBinary.length} binary-only` : 'no difference found: an exact match by this measure');
