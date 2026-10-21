// lint-test
// WHY: main's bootstrap job failed on one HTTP 504 from GitHub's release host while fetching gitleaks (2026-10-15). A
// download that installs something tries a passing 5xx again; the checksum after it is unchanged and still decides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const scripts = () => [join('scripts', 'bootstrap.sh'), ...readdirSync(join(repoRoot, 'scripts', 'setup')).filter((f) => f.endsWith('.sh')).map((f) => join('scripts', 'setup', f))];

/** Every curl in the install scripts that writes a file (-o or -O): a download. */
function downloads(): { file: string; line: string }[] {
  return scripts().flatMap((file) =>
    readFileSync(join(repoRoot, file), 'utf8')
      .split('\n')
      // A probe that writes to /dev/null (answers()) is no download.
      .filter((l) => /\bcurl\b/.test(l) && /\s-[A-Za-z]*[oO]\b|\s-O\b/.test(l) && !/-o \/dev\/null/.test(l) && !/^\s*#/.test(l))
      .map((line) => ({ file, line: line.trim() })),
  );
}

test('every download in the install scripts tries a passing server error again (--retry)', () => {
  const all = downloads();
  assert.ok(all.some((d) => d.file.endsWith('bootstrap.sh')), "found bootstrap.sh's download");
  assert.deepEqual(all.filter((d) => !/--retry \d/.test(d.line)).map((d) => `${d.file}: ${d.line}`), []);
});

test("bootstrap.sh's download, with its own curl flags: a 504 then the file succeeds; the checksum still runs after", { skip: process.platform === 'win32' && 'curl and bash' }, async () => {
  const src = readFileSync(join(repoRoot, 'scripts', 'bootstrap.sh'), 'utf8');
  const fn = /^fetch_checked\(\) \{[\s\S]*?^\}/m.exec(src)![0];
  const curl = /^\s*curl (.*) -o "\$out" "\$url"$/m.exec(fn)![1]!.split(/\s+/);
  assert.match(fn, /got="\$\(sha256_of "\$out"\)"\n\s*\[ "\$got" = "\$want" \] \|\| \{ rm -f "\$out"; die "checksum mismatch/, 'the checksum check is unchanged');
  let asked = 0;
  const s = createServer((_req, res) => (++asked === 1 ? res.writeHead(504).end('gateway timeout') : res.writeHead(200).end('the file')));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  try {
    const out = join(mkdtempSync(join(tmpdir(), 'retry-')), 'f');
    const url = `http://127.0.0.1:${(s.address() as { port: number }).port}/f`;
    // Async: the server answering is in this process.
    await promisify(execFile)('curl', [...curl, '-o', out, url], { timeout: 30_000 });
    assert.equal(readFileSync(out, 'utf8'), 'the file');
    assert.equal(asked, 2, 'asked again once after the 504');
  } finally {
    s.close();
  }
});
