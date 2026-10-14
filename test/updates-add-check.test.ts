// updates.sh --add-check: names appended to an existing /etc/worklane/updates.json's required_checks, by
// scripts/setup/updates-root.cjs add-checks, and nothing else changed. Here with its fixed paths pointed into a temp
// root; the CI step "updates.sh --add-check, as root" in ci-slow.yml runs the real script on real systemd as root.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { repoRoot } from './helpers.js';

const require_ = createRequire(import.meta.url);

/** updates-root.cjs and the two scripts it loads, side by side in a temp root, /etc/worklane and the change log in it. */
function rootIn() {
  const root = mkdtempSync(join(tmpdir(), 'updates-add-check-'));
  const etc = join(root, 'etc');
  const log = join(root, 'var', 'machine-changes.jsonl');
  mkdirSync(etc, { recursive: true });
  mkdirSync(join(root, 'var'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'machine'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'setup'), { recursive: true });
  const paths = (s: string) =>
    s
      .replace("const ETC = '/etc/worklane';", `const ETC = ${JSON.stringify(etc)};`)
      .replace("const LOG = '/var/lib/worklane/machine-changes.jsonl';", `const LOG = ${JSON.stringify(log)};`)
      .replace("const SIGNERS_STATE = '/var/lib/worklane/signers-state.json';", `const SIGNERS_STATE = ${JSON.stringify(join(root, 'var', 'signers-state.json'))};`);
  for (const f of ['machine/worklane-machine.cjs', 'machine/worklane-update.cjs', 'setup/updates-root.cjs']) writeFileSync(join(root, 'scripts', f), paths(readFileSync(join(repoRoot, 'scripts', f), 'utf8')));
  const rootCopy = join(root, 'scripts', 'setup', 'updates-root.cjs');
  const file = join(etc, 'updates.json');
  const run = (...names: string[]) => spawnSync(process.execPath, [rootCopy, 'add-checks', ...names], { encoding: 'utf8', env: { ...process.env, SUDO_USER: 'admin' } });
  const logged = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { what: string; by: string; to: string }) : []);
  return { root, etc, file, rootCopy, run, logged };
}

/** An existing file as updates.sh's updates_config_json lays it out, with an owner's own values in it. */
const PRETTY = `{
  "enabled": true,
  "channel": "main",
  "allowed_signers": "/etc/worklane/allowed_signers",
  "repo_url": "https://example.invalid/fork.git",
  "branch": "stable",
  "required_checks": [
    "scan",
    "test (ubuntu-latest, 22)"
  ],
  "extra": {"kept": [1, 2]}
}
`;

test('--add-check appends each new name after the ones there, in the list\'s own layout; every other byte stays', () => {
  const m = rootIn();
  writeFileSync(m.file, PRETTY, { mode: 0o640 });
  const r = m.run('wizard end to end (real systemd)', 'test (ubuntu-latest, 24)');
  assert.equal(r.status, 0, r.stderr);
  const want = PRETTY.replace('    "test (ubuntu-latest, 22)"\n', '    "test (ubuntu-latest, 22)",\n    "wizard end to end (real systemd)",\n    "test (ubuntu-latest, 24)"\n');
  assert.equal(readFileSync(m.file, 'utf8'), want);
  assert.equal(statSync(m.file).mode & 0o7777, 0o640, 'the file\'s own mode is kept');
  assert.equal(
    r.stdout,
    `${m.file} required_checks before:\n  "scan"\n  "test (ubuntu-latest, 22)"\nadded: "wizard end to end (real systemd)"\nadded: "test (ubuntu-latest, 24)"\n${m.file} required_checks after:\n  "scan"\n  "test (ubuntu-latest, 22)"\n  "wizard end to end (real systemd)"\n  "test (ubuntu-latest, 24)"\n`,
  );
  assert.deepEqual(m.logged().map((c) => [c.what, c.by, c.to]), [['updates.required_checks', 'admin', 'added "wizard end to end (real systemd)", "test (ubuntu-latest, 24)"']]);
});

test('--add-check keeps a one-line file one line (as --channel writes it), and fills an empty list', () => {
  const m = rootIn();
  const compact = '{"enabled":false,"channel":"release","repo_url":"u","branch":"main","required_checks":["scan","dco"],"z":0}\n';
  writeFileSync(m.file, compact);
  assert.equal(m.run('desktop').status, 0);
  assert.equal(readFileSync(m.file, 'utf8'), '{"enabled":false,"channel":"release","repo_url":"u","branch":"main","required_checks":["scan","dco","desktop"],"z":0}\n');
  writeFileSync(m.file, '{"required_checks": [ ], "enabled": false}');
  assert.equal(m.run('a', 'b (c, d)').status, 0);
  assert.equal(readFileSync(m.file, 'utf8'), '{"required_checks": ["a", "b (c, d)" ], "enabled": false}');
  // Spaced as `, ` on one line: so is the new entry.
  writeFileSync(m.file, '{"required_checks": ["a", "b"]}');
  assert.equal(m.run('c').status, 0);
  assert.equal(readFileSync(m.file, 'utf8'), '{"required_checks": ["a", "b", "c"]}');
});

test('--add-check is idempotent: a name already listed, or given twice, is said and skipped; the file isn\'t rewritten', () => {
  const m = rootIn();
  writeFileSync(m.file, PRETTY);
  assert.equal(m.run('dco').status, 0);
  const once = readFileSync(m.file, 'utf8');
  const ino = statSync(m.file).ino;
  const again = m.run('dco', 'scan');
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^already listed, skipped: "dco"$/m);
  assert.match(again.stdout, /^already listed, skipped: "scan"$/m);
  assert.match(again.stdout, /^nothing to add; the file is unchanged$/m);
  assert.equal(readFileSync(m.file, 'utf8'), once);
  assert.equal(statSync(m.file).ino, ino, 'not rewritten');
  // The same new name twice in one run: added once.
  const twice = m.run('push-gate', 'push-gate');
  assert.equal(twice.status, 0);
  assert.deepEqual((JSON.parse(readFileSync(m.file, 'utf8')) as { required_checks: string[] }).required_checks, ['scan', 'test (ubuntu-latest, 22)', 'dco', 'push-gate']);
  assert.match(twice.stdout, /^already listed, skipped: "push-gate"$/m);
  assert.equal(m.logged().length, 2, 'one log line per run that added something');
});

test('--add-check refuses a bad name (empty, a control character, edge spaces, split parentheses) and changes nothing', () => {
  const m = rootIn();
  writeFileSync(m.file, PRETTY);
  for (const [bad, why] of [
    ['', /is empty/],
    ['   ', /is empty/],
    ['a\nb', /newline or another control character/],
    ['a\tb', /control character/],
    ['a\u001bb', /control character/], // an escape (a NUL can't be in an argument at all)
    ['a\u007fb', /control character/],
    ['a\u0085b', /control character/],
    [' scan', /starts or ends with a space/],
    ['test (macos-latest', /unbalanced parentheses/],
    ['22)', /unbalanced parentheses/],
  ] as const) {
    const r = m.run('fine', bad);
    assert.equal(r.status, 2, JSON.stringify(bad));
    assert.match(r.stderr, why, JSON.stringify(bad));
    assert.match(r.stderr, /Nothing was changed\./);
  }
  assert.equal(m.run().status, 2, 'no name at all: usage');
  assert.equal(readFileSync(m.file, 'utf8'), PRETTY);
  assert.deepEqual(m.logged(), []);
  // The same rule updates.sh's warning about an existing file uses.
  const { unbalanced } = require_(m.rootCopy) as { unbalanced: (n: string) => boolean };
  assert.deepEqual(['test (macos-latest', '22)', 'test (macos-latest, 22)', 'scan'].map(unbalanced), [true, true, false, false]);
});

test('--add-check with no updates.json refuses, saying to install the updater first, and makes nothing', () => {
  const m = rootIn();
  const r = m.run('scan');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /updates\.json doesn't exist: install the updater first \(sudo bash scripts\/setup\/updates\.sh, without --add-check\), then run --add-check again\. Nothing was changed\./);
  assert.deepEqual(readdirSync(m.etc), []);
  // No list to add to, or not JSON: refused, as it was.
  for (const t of ['{"enabled": false}\n', '{"required_checks": "scan"}\n', '{"required_checks": [1]}\n', 'not json']) {
    writeFileSync(m.file, t);
    assert.equal(m.run('scan').status, 1, t);
    assert.equal(readFileSync(m.file, 'utf8'), t);
  }
});

test('--add-check writes atomically: the whole new file in a dotted temp file beside it, with its mode, then renamed over it', () => {
  const m = rootIn();
  writeFileSync(m.file, PRETTY, { mode: 0o644 });
  const fs = require_('node:fs') as typeof import('node:fs');
  const steps = require_(m.rootCopy) as { addChecks: (n: string[]) => number };
  const real = fs.renameSync;
  const seen: { from: string; to: string; tmp: string; dest: string; mode: number }[] = [];
  const write = process.stdout.write;
  try {
    (process.stdout as { write: unknown }).write = () => true;
    fs.renameSync = ((from: string, to: string) => {
      seen.push({ from, to, tmp: readFileSync(from, 'utf8'), dest: readFileSync(to, 'utf8'), mode: statSync(from).mode & 0o7777 });
      real(from, to);
    }) as typeof fs.renameSync;
    assert.equal(steps.addChecks(['dco']), 0);
    assert.deepEqual(readdirSync(m.etc), ['updates.json'], 'renamed: no temp file left');
    // A rename that fails: the file is as it was, whole; the unfinished new one is left (the script removes nothing) and named.
    fs.renameSync = (() => {
      throw new Error('disk gone');
    }) as typeof fs.renameSync;
    const errs: string[] = [];
    const ew = process.stderr.write;
    (process.stderr as { write: unknown }).write = (s: string) => errs.push(s);
    try {
      assert.equal(steps.addChecks(['scope']), 1);
    } finally {
      (process.stderr as { write: unknown }).write = ew;
    }
    assert.match(errs.join(''), /writing it failed \(disk gone\); it is as it was \(the unfinished new one is left at .*\/\.updates\.json\.tmp-\d+-[0-9a-f]{8}; delete it\)/);
  } finally {
    fs.renameSync = real;
    (process.stdout as { write: unknown }).write = write;
  }
  const after = PRETTY.replace('    "test (ubuntu-latest, 22)"\n', '    "test (ubuntu-latest, 22)",\n    "dco"\n');
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.to, m.file);
  assert.equal(dirname(seen[0]!.from), m.etc, 'a temp file in the same directory');
  assert.match(basename(seen[0]!.from), new RegExp(`^\\.updates\\.json\\.tmp-${process.pid}-[0-9a-f]{8}$`), 'a dotted name, new each time');
  assert.equal(seen[0]!.tmp, after, 'the temp file holds the whole new file before the rename');
  assert.equal(seen[0]!.dest, PRETTY, 'and until the rename the file is the old one, whole');
  assert.equal(seen[0]!.mode, 0o644);
  assert.equal(readFileSync(m.file, 'utf8'), after, 'the failed second run left the first one\'s file');
  const files = readdirSync(m.etc).sort();
  assert.equal(files.length, 2);
  assert.equal(files[1], 'updates.json');
  assert.match(files[0]!, /^\.updates\.json\.tmp-/, 'the failed one\'s unfinished file, beside it');
});

test('updates.sh: --add-check is its own mode (the edit only), refuses other options, and the warning reuses the split-name rule', () => {
  const s = readFileSync(join(repoRoot, 'scripts', 'setup', 'updates.sh'), 'utf8');
  const parse = s.indexOf('while [ "$#" -gt 0 ]');
  const edit = s.indexOf('exec node "$root_steps" add-checks "${add_checks[@]}"');
  const install = s.indexOf('say "the updater, root-owned"');
  assert.ok(parse > 0 && edit > parse && install > edit, 'the edit runs, and exec ends the script, before anything is installed');
  assert.match(s, /--add-check\) \[ "\$#" -ge 2 \] && \[\[ "\$2" != --\* \]\] \|\| \{ echo "--add-check needs a check name" >&2; exit 2; \}; add_checks\+=\("\$2"\); shift 2 ;;/);
  assert.match(s, /\[ "\$others" -eq 0 \] \|\| \{ echo "--add-check only edits \/etc\/worklane\/updates\.json and takes no other option; run it on its own\. Nothing was installed or changed\." >&2; exit 2; \}/);
  assert.match(s, /\*\) echo "unknown argument \$1" >&2; exit 2 ;;/);
  assert.match(s, /node -e 'const \{ unbalanced \} = require\(process\.argv\[1\]\);.*c\.filter\(unbalanced\).*' "\$root_steps" \|\| true/);
  assert.doesNotMatch(s, /n\.match\(\/\\\(\/g\)/, 'one split-name rule, in updates-root.cjs');
});
