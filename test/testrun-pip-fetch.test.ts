// The pip fetch (src/testrun/fetch.ts pipFetchScript, docs/test-runs.md "Network"): with network, the wheels of what
// the requirements files pin and of the repo's build requirements go into the run's cache, and none of the repo's code
// runs; then the offline install step (pip install --no-index) builds the repo (-e .) from the cache alone. Here: the
// config, and the script as the local host runs it, with real Python and pip and no network: a python3 on PATH that
// gives each `pip download` the fixtures' directory as its index (--no-index --find-links), and logs what it was
// asked. The fixtures (scripts/ci/testrun-pip-fixtures.py) carry canaries: the repo's in-tree build backend and an
// sdist's each leave a marker when built. The real-systemd job (scripts/ci/testrun-pip-real-systemd.sh) proves the
// same in the sandbox, with an index on a public stand-in, and that the install step has no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TestRunConfig } from '../src/testrun/config.js';
import { localHost } from '../src/testrun/host.js';
import { repoRoot } from './helpers.js';

const posix = process.platform !== 'win32';
const python = ['/usr/bin/python3', '/usr/local/bin/python3', '/bin/python3'].find((p) => existsSync(p));
const pipOk = (() => {
  if (!posix || !python) return false;
  // tomllib (3.11) and pip with --python (22.3), as the fetch and the install step here need.
  const r = spawnSync(python, ['-I', '-c', 'import tomllib, sys; from pip import __version__ as v; sys.exit(0 if tuple(map(int, v.split(".")[:2])) >= (22, 3) else 1)'], { encoding: 'utf8' });
  return r.status === 0;
})();
const skip = !pipOk && 'python3 3.11+ with pip 22.3+';
const fixtures = join(repoRoot, 'scripts', 'ci', 'testrun-pip-fixtures.py');
const tiers = [{ name: 'a', command: 'x', kind: 'fast' }];

test('tests.yaml: a pip fetch names a PIP_FIND_LINKS cache and its requirements files (requirements.txt unless named), each a path the helper takes', () => {
  const pip = { name: 'pip', env: 'PIP_FIND_LINKS', key: ['requirements.txt'] };
  assert.deepEqual(TestRunConfig.parse({ fetch: [{ pip: 'pip' }], caches: [pip], tiers }).fetch, [{ pip: 'pip', requirements: ['requirements.txt'] }]);
  assert.deepEqual(TestRunConfig.parse({ fetch: [{ pip: 'pip', requirements: ['req/base.txt', 'req/dev.txt'] }], caches: [pip], tiers }).fetch, [{ pip: 'pip', requirements: ['req/base.txt', 'req/dev.txt'] }]);
  assert.throws(() => TestRunConfig.parse({ fetch: [{ pip: 'pip' }], caches: [{ ...pip, env: 'npm_config_cache' }], tiers }), /pip's fetch needs PIP_FIND_LINKS/);
  assert.throws(() => TestRunConfig.parse({ fetch: [{ npm: 'pip' }], caches: [pip], tiers }), /npm's fetch needs npm_config_cache/);
  assert.throws(() => TestRunConfig.parse({ fetch: [{ pip: 'nope' }], caches: [pip], tiers }), /no cache named nope/);
  for (const bad of ['../r.txt', '/etc/r.txt', 'a b.txt', '$R', './r.txt']) assert.throws(() => TestRunConfig.parse({ fetch: [{ pip: 'pip', requirements: [bad] }], caches: [pip], tiers }), /a path inside the repo/, bad);
  assert.throws(() => TestRunConfig.parse({ fetch: [{ pip: 'pip', requirements: [] }], caches: [pip], tiers }));
  assert.throws(() => TestRunConfig.parse({ fetch: [{ pip: 'pip', requirements: Array.from({ length: 9 }, (_, i) => `r${i}.txt`) }], caches: [pip], tiers }));
  assert.throws(() => TestRunConfig.parse({ fetch: [{ pip: 'pip', npm: 'pip' }], caches: [pip], tiers }), 'one fetcher per entry');
});

/** The fixtures, a python3 that gives `pip download` the fixtures' index, and a local host with a run of the repo. */
function rig(files: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pip-fetch-'));
  const fx = join(dir, 'fx');
  const key = 'e'.repeat(32);
  // The local host's cache directory for this key: the planted wheel names evil's sdist there.
  const cacheDir = join(dir, 'base', 'cache', `pip-${key}`);
  const made = spawnSync(python!, ['-I', fixtures, fx, '--planted-url', `file://${join(cacheDir, 'evil-1.0.tar.gz')}`], { encoding: 'utf8' });
  assert.equal(made.status, 0, made.stderr);
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const log = join(dir, 'pip.log');
  writeFileSync(log, '');
  // Each `pip download`: its arguments, then the requirements file it was given, as it was then.
  writeFileSync(
    join(bin, 'python3'),
    `#!/bin/sh\nif [ "$1 $2 $3 $4" = "-I -m pip download" ]; then\n  printf 'ARGS %s\\n' "$*" >> '${log}'\n  prev=; for a in "$@"; do [ "$prev" = -r ] && cat "$a" >> '${log}'; prev="$a"; done\n  exec ${python} "$@" --no-index --find-links '${join(fx, 'index')}'\nfi\nexec ${python} "$@"\n`,
  );
  chmodSync(join(bin, 'python3'), 0o755);
  const base = join(dir, 'base');
  const host = localHost(base, { path: `${bin}:/usr/bin:/bin` });
  const work = join(base, 'runs', 'fast-p-1', 'work');
  mkdirSync(join(base, 'runs', 'fast-p-1', 'tmp'), { recursive: true });
  cpSync(join(fx, 'repo'), work, { recursive: true });
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(join(work, f, '..'), { recursive: true });
    writeFileSync(join(work, f), t);
  }
  return {
    dir,
    fx,
    work,
    host,
    cache: async () => {
      const c = await host.cache('pip', key);
      assert.equal(c, cacheDir);
      return c;
    },
    fetch: async (...reqs: string[]) => {
      const x = await host.fetch('fast-p-1', 'pip', 'pip', key, 120_000, undefined, reqs.length ? reqs : ['requirements.txt']);
      return { ...x, err: x.err ?? '' };
    },
    log: () => readFileSync(log, 'utf8'),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('pip fetch: the wheels of the pins and of the repo\'s build requirements land in the cache; no code of the repo runs (its build backend, for its -e . line); pip downloads only the fetch\'s own files, wheels only', { skip }, async () => {
  const r = rig();
  try {
    const out = await r.fetch();
    assert.equal(out.code, 0, out.out + out.err);
    assert.match(out.out, /^fetch: 1 pinned in requirements\.txt; build requirements: standin-backend>=1$/m);
    assert.match(out.out, /^fetch: 2 wheels into the cache: standin-1\.0-py3-none-any\.whl, standin_backend-1\.0-py3-none-any\.whl$/m);
    assert.match(out.out, /fetch: every pinned package and build requirement is in the cache, as wheels\n?$/);
    assert.deepEqual(readdirSync(await r.cache()).sort(), ['standin-1.0-py3-none-any.whl', 'standin_backend-1.0-py3-none-any.whl']);
    assert.ok(!existsSync(join(r.work, 'repo-ran')), 'the repo\'s build backend never ran');
    const asked = r.log().split('\n').filter((l) => l.startsWith('ARGS '));
    assert.equal(asked.length, 1);
    const cache = await r.cache();
    for (const a of asked) {
      assert.ok(a.includes(' --only-binary=:all: --no-deps '), a);
      assert.match(a, / -r round-\d+-(plain|hashed)\.txt$/, 'never a file of the repo\'s');
      assert.ok(!a.includes(cache), 'never the cache');
    }
    assert.match(r.log(), /^standin==1\.0\nstandin-backend>=1\n/m);
    // The probe can tell: pip download of the repo's own file, even with --only-binary=:all:, builds the -e . line.
    const naive = spawnSync(python!, ['-I', '-m', 'pip', 'download', '--only-binary=:all:', '--no-index', '--find-links', join(r.fx, 'index'), '-d', join(r.dir, 'naive'), '-r', 'requirements.txt'], { cwd: r.work, encoding: 'utf8' });
    assert.equal(naive.status, 0, naive.stderr);
    assert.ok(existsSync(join(r.work, 'repo-ran')), 'pip download -r requirements.txt runs the repo\'s build backend');
  } finally {
    r.done();
  }
});

test('pip fetch, then the offline install step: pip install --no-index builds the repo (-e .) from the cache alone, and the repo\'s code runs there', { skip }, async () => {
  const r = rig();
  try {
    const f = await r.fetch();
    assert.equal(f.code, 0, f.out + f.err);
    assert.ok(!existsSync(join(r.work, 'repo-ran')));
    const install = await r.host.exec('fast-p-1', 'python3 -m venv --without-pip .venv && python3 -m pip --python .venv/bin/python install --no-index -r requirements.txt && .venv/bin/python -c "import standin, standin_repo; print(standin.X, standin_repo.Y)"', { PIP_FIND_LINKS: await r.cache() }, 120_000);
    assert.equal(install.code, 0, install.out + install.err);
    assert.match(install.out, /^1 2$/m);
    assert.ok(existsSync(join(r.work, 'repo-ran')), 'the repo\'s build backend ran in the install step');
    // Nothing asked the index there: the stand-in python3 logs every pip download, and that was the fetch's one.
    assert.equal(r.log().split('\n').filter((l) => l.startsWith('ARGS ')).length, 1);
  } finally {
    r.done();
  }
});

test('pip fetch: a pin with no wheel (an sdist only) fails the fetch, which never builds it; without --only-binary, or with a --no-binary line, pip download would', { skip }, async () => {
  const r = rig({ 'nobinary.txt': '--no-binary evil\nevil==1.0\n' });
  const evil = join(r.fx, 'markers', 'evil-ran');
  try {
    const out = await r.fetch('requirements-sdist.txt');
    assert.equal(out.code, 4, out.out + out.err);
    assert.match(out.err, /fetch: pip download failed: the fetch takes wheels only \(building an sdist runs its code\)/);
    assert.ok(!existsSync(evil), 'evil\'s build backend never ran');
    // The probe can tell: a requirements file's --no-binary overrides the command line's --only-binary=:all: for that
    // package (pip 24), and pip builds the sdist; the fetch refuses that line before pip runs.
    const refused = await r.fetch('nobinary.txt');
    assert.equal(refused.code, 3);
    assert.match(refused.err, /fetch: nobinary\.txt line 1: --no-binary: an option the fetch does not take/);
    const naive = spawnSync(python!, ['-I', '-m', 'pip', 'download', '--only-binary=:all:', '--no-index', '--find-links', join(r.fx, 'index'), '-d', join(r.dir, 'naive'), '-r', 'nobinary.txt'], { cwd: r.work, encoding: 'utf8' });
    assert.equal(naive.status, 0, naive.stderr);
    assert.ok(existsSync(evil), 'pip download built the sdist: its code ran');
  } finally {
    r.done();
  }
});

test('pip fetch never reads the cache: a wheel a run planted there (standin 1.0+evil, needing evil @ file://<its sdist, planted too>) is never chosen, and evil is never built; pip reading the cache would build it', { skip }, async () => {
  const r = rig();
  const evil = join(r.fx, 'markers', 'evil-ran');
  try {
    const cache = await r.cache();
    const planted = 'standin-1.0+evil-py3-none-any.whl';
    cpSync(join(r.fx, 'planted', planted), join(cache, planted));
    cpSync(join(r.fx, 'index', 'evil-1.0.tar.gz'), join(cache, 'evil-1.0.tar.gz'));
    // A run's symlink where a chosen wheel goes is replaced, never written through.
    writeFileSync(join(r.dir, 'target'), 'not to be written');
    symlinkSync(join(r.dir, 'target'), join(cache, 'standin_backend-1.0-py3-none-any.whl'));
    const out = await r.fetch();
    assert.equal(out.code, 0, out.out + out.err);
    assert.ok(!existsSync(evil), 'evil\'s build backend never ran');
    assert.match(out.out, /^fetch: 2 wheels into the cache: standin-1\.0-py3-none-any\.whl, standin_backend-1\.0-py3-none-any\.whl$/m);
    assert.equal(readFileSync(join(r.dir, 'target'), 'utf8'), 'not to be written');
    const genuine = readFileSync(join(r.fx, 'index', 'standin-1.0-py3-none-any.whl'));
    assert.ok(readFileSync(join(cache, 'standin-1.0-py3-none-any.whl')).equals(genuine), 'the index\'s standin, copied in');
    // The probe can tell: pip download with the cache as a find-links source (as this fetch's first version ran it)
    // chooses the planted wheel and builds evil from its direct reference, --only-binary=:all: or not.
    const naive = spawnSync(python!, ['-I', '-m', 'pip', 'download', '--only-binary=:all:', '--no-index', '--find-links', join(r.fx, 'index'), '--find-links', cache, '-d', join(r.dir, 'naive'), 'standin==1.0'], { cwd: r.dir, encoding: 'utf8' });
    assert.ok(existsSync(evil), `pip reading the cache built evil: ${naive.stdout}${naive.stderr}`);
  } finally {
    r.done();
  }
});

test('pip fetch follows dependencies itself, from each wheel\'s METADATA (an extra\'s too), and refuses a dependency that is a direct reference, before pip could build it', { skip }, async () => {
  const r = rig();
  const evil = join(r.fx, 'markers', 'evil-ran');
  try {
    const tool = await r.fetch('requirements-tool.txt');
    assert.equal(tool.code, 0, tool.out + tool.err);
    assert.deepEqual(readdirSync(await r.cache()).sort(), ['standin-1.0-py3-none-any.whl', 'standin_backend-1.0-py3-none-any.whl', 'standin_tool-1.0-py3-none-any.whl']);
    for (const a of r.log().split('\n').filter((l) => l.startsWith('ARGS '))) assert.ok(a.includes(' --no-deps '), a);
    const direct = await r.fetch('requirements-direct.txt');
    assert.equal(direct.code, 3, direct.out + direct.err);
    assert.match(direct.err, /fetch: standin_direct-1\.0-py3-none-any\.whl depends on evil @ file:\/\/\S+evil-1\.0\.tar\.gz: a direct reference, which pip would build: the fetch takes packages from the index only/);
    assert.ok(!existsSync(evil), 'evil\'s build backend never ran');
    // The probe can tell: pip resolving the dependencies itself builds evil, --only-binary=:all: or not.
    const naive = spawnSync(python!, ['-I', '-m', 'pip', 'download', '--only-binary=:all:', '--no-index', '--find-links', join(r.fx, 'index'), '-d', join(r.dir, 'naive'), 'standin-direct==1.0'], { cwd: r.dir, encoding: 'utf8' });
    assert.ok(existsSync(evil), `pip following the dependency built evil: ${naive.stdout}${naive.stderr}`);
  } finally {
    r.done();
  }
});

test('pip fetch refuses, before pip runs, anything but a pin, -r and the repo\'s own directory: options, URLs, direct references, ranges, paths outside the repo, symlinks', { skip }, async () => {
  // Each: a requirements file's line, and what the fetch says of it.
  const cases: Array<[string, string]> = [
    ['--index-url https://example.com/simple', 'r.txt line 1: --index-url: an option the fetch does not take'],
    ['-i https://example.com/simple', 'r.txt line 1: -i: an option'],
    ['--extra-index-url https://example.com/simple', 'r.txt line 1: --extra-index-url: an option'],
    ['-f https://example.com/links', 'r.txt line 1: -f: an option'],
    ['--find-links=./wheels', 'r.txt line 1: --find-links=./wheels: an option'],
    ['--trusted-host example.com', 'r.txt line 1: --trusted-host: an option'],
    ['-c constraints.txt', 'r.txt line 1: -c: an option'],
    ['--prefer-binary', 'r.txt line 1: --prefer-binary: an option'],
    ['standin>=1.0', 'r.txt line 1: standin>=1.0: not a pin'],
    ['standin==1.*', 'r.txt line 1: standin==1.*: not a pin'],
    ['standin', 'r.txt line 1: standin: not a pin'],
    ['evil @ https://example.com/evil-1.0.tar.gz', 'r.txt line 1: evil @ https://example.com/evil-1.0.tar.gz: a URL, path or direct reference'],
    ['https://example.com/evil-1.0.tar.gz', 'r.txt line 1: https://example.com/evil-1.0.tar.gz: a URL, path or direct reference'],
    ['git+https://example.com/evil.git#egg=evil', 'r.txt line 1: git+https://example.com/evil.git#egg=evil: a URL, path or direct reference'],
    ['-e git+https://example.com/evil.git#egg=evil', 'r.txt line 1: git+https://example.com/evil.git#egg=evil: not a directory of the repo'],
    ['-e ../outside', 'r.txt line 1: ../outside: not a path inside the repo'],
    ['-e ./missing', 'r.txt line 1: ./missing: no such directory in the repo'],
    ['/etc/evil', 'r.txt line 1: /etc/evil: a URL, path or direct reference'],
    ['evil-1.0.tar.gz', 'r.txt line 1: evil-1.0.tar.gz: pip would read it as an archive file'],
    ['standin==${V}', 'r.txt line 1: standin==${V}: a URL, path or direct reference'],
    ['standin==1.0 --config-settings=x=y', 'r.txt line 1: --config-settings=x=y: the only option a pin may have is --hash'],
    ['standin==1.0 --global-option=x', 'r.txt line 1: --global-option=x: the only option a pin may have is --hash'],
    ['standin==1.0 --hash=md5:0123', 'r.txt line 1: --hash=md5:0123: the only option a pin may have is --hash'],
    ['standin==1.0 ; python_version >= "3" --no-binary :all:', 'r.txt line 1: --no-binary: the only option a pin may have is --hash'],
    ['-r ../../outside.txt', 'r.txt line 1: ../../outside.txt: not a path inside the repo'],
    ['-r missing.txt', 'missing.txt: no such file in the repo'],
    ['-r nested/bad.txt', 'nested/bad.txt line 2: --index-url: an option'],
    ['-r', 'r.txt line 1: -r takes one path'],
    // Names and versions pip reads as a local archive file, relative to its working directory.
    ['standin==1.0+x.tar.gz', 'r.txt line 1: standin==1.0+x.tar.gz: pip would read it as an archive file'],
    ['evil.whl', 'r.txt line 1: evil.whl: pip would read it as an archive file'],
    ['standin==1.0\x01', 'r.txt line 1: a control character'],
  ];
  const r = rig({ 'nested/bad.txt': '# fine so far\n--index-url https://example.com/simple\n' });
  try {
    for (const [content, want] of cases) {
      writeFileSync(join(r.work, 'r.txt'), `${content}\n`);
      const out = await r.fetch('r.txt');
      assert.equal(out.code, 3, `${content}: ${out.out}${out.err}`);
      assert.ok(out.err.includes(`fetch: ${want}`), `${content}: ${out.err}`);
    }
    // A requirements file, or a pyproject.toml, that is a symlink (here to one outside the repo) is never read.
    writeFileSync(join(r.dir, 'outside.txt'), 'standin==1.0\n');
    symlinkSync(join(r.dir, 'outside.txt'), join(r.work, 'link.txt'));
    const link = await r.fetch('link.txt');
    assert.equal(link.code, 3);
    assert.match(link.err, /fetch: link\.txt: a symlink, or under one/);
    writeFileSync(join(r.work, 'r.txt'), 'standin==1.0\n');
    rmSync(join(r.work, 'pyproject.toml'));
    symlinkSync(join(r.fx, 'repo', 'pyproject.toml'), join(r.work, 'pyproject.toml'));
    const toml = await r.fetch('r.txt');
    assert.equal(toml.code, 3);
    assert.match(toml.err, /fetch: pyproject\.toml: a symlink, or under one/);
    // A build requirement that is a direct reference.
    rmSync(join(r.work, 'pyproject.toml'));
    writeFileSync(join(r.work, 'pyproject.toml'), '[build-system]\nrequires = ["evil @ https://example.com/evil-1.0.tar.gz"]\nbuild-backend = "x"\n');
    const direct = await r.fetch('r.txt');
    assert.equal(direct.code, 3);
    assert.match(direct.err, /fetch: pyproject\.toml: build requirement evil @ https:\/\/example\.com\/evil-1\.0\.tar\.gz: the fetch takes a name and version ranges from the index only/);
    // Build requirements pip would read as an archive file, and one with a newline (two lines of a requirements file).
    for (const [x, why] of [
      ['"evil.tar.gz"', /build requirement evil\.tar\.gz: the fetch takes a name and version ranges from the index only \(no URL, direct reference or archive file\)/],
      ['"x.whl"', /build requirement x\.whl: the fetch takes/],
      ['"setuptools>=1.0+x.zip"', /build requirement setuptools>=1\.0\+x\.zip: the fetch takes/],
      ['"setuptools\\n>=1"', /build requirement 'setuptools\\n>=1': a control character/],
    ] as const) {
      writeFileSync(join(r.work, 'pyproject.toml'), `[build-system]\nrequires = [${x}]\nbuild-backend = "x"\n`);
      const got = await r.fetch('r.txt');
      assert.equal(got.code, 3, `${x}: ${got.out}${got.err}`);
      assert.match(got.err, why, x);
    }
    assert.equal(r.log(), '', 'pip never ran');
    assert.ok(!existsSync(join(r.work, 'repo-ran')) && !existsSync(join(r.fx, 'markers', 'evil-ran')));
  } finally {
    r.done();
  }
});

test('pip fetch takes pins as pip-compile and pip freeze write them: extras, markers, ===, hashes over continued lines, comments, -r (relative to its file), the repo as . or -e ./ with extras', { skip }, async () => {
  const r = rig();
  try {
    const sha = createHash('sha256').update(readFileSync(join(r.fx, 'index', 'standin-1.0-py3-none-any.whl'))).digest('hex');
    writeFileSync(join(r.work, 'requirements.txt'), `# pinned\n-r req/more.txt\nstandin[extra]==1.0 ; python_version >= '3' and os_name != "nt" \\\n    --hash=sha256:${sha}  # the wheel\n-e ./[dev]\n.\n`);
    mkdirSync(join(r.work, 'req'));
    writeFileSync(join(r.work, 'req', 'more.txt'), 'evil===1.0 ; python_version < "3"\n--requirement=../requirements.txt\n');
    const out = await r.fetch();
    assert.equal(out.code, 0, out.out + out.err);
    assert.match(out.out, /^fetch: 2 pinned in requirements\.txt; build requirements: standin-backend>=1$/m);
    // The fetch's own files: one canonical line per pin, nothing else of the repo's; evil's marker excludes it here,
    // so it is never asked for.
    assert.ok(r.log().includes(`\nstandin[extra]==1.0 ; python_version >= '3' and os_name != "nt" --hash=sha256:${sha}\n`), r.log());
    assert.ok(!r.log().includes('evil'), r.log());
    assert.ok(!existsSync(join(r.work, 'repo-ran')) && !existsSync(join(r.fx, 'markers', 'evil-ran')));
    assert.deepEqual(readdirSync(await r.cache()).sort(), ['standin-1.0-py3-none-any.whl', 'standin_backend-1.0-py3-none-any.whl']);
    // A hash that doesn't match the wheel fails the download (pip checks it).
    writeFileSync(join(r.work, 'requirements.txt'), `standin==1.0 --hash=sha256:${'0'.repeat(64)}\n`);
    rmSync(await r.cache(), { recursive: true, force: true });
    const bad = await r.fetch();
    assert.equal(bad.code, 4, bad.out + bad.err);
    assert.match(bad.err, /THESE PACKAGES DO NOT MATCH THE HASHES/);
  } finally {
    r.done();
  }
});

test('pip fetch: a repo with no pyproject.toml but a setup.py gets setuptools and wheel for its build; one with neither, no build requirements; a requirements file it can\'t read is named', { skip }, async () => {
  const r = rig();
  try {
    rmSync(join(r.work, 'pyproject.toml'));
    writeFileSync(join(r.work, 'requirements.txt'), 'standin==1.0\n');
    writeFileSync(join(r.work, 'setup.py'), 'raise SystemExit("never run here")\n');
    const legacy = await r.fetch();
    // The fixtures' index has no setuptools: the download of the build requirements fails, after naming them.
    assert.equal(legacy.code, 4, legacy.out + legacy.err);
    assert.match(legacy.out, /^fetch: 1 pinned in requirements\.txt; build requirements: setuptools>=40\.8\.0, wheel$/m);
    rmSync(join(r.work, 'setup.py'));
    const plain = await r.fetch();
    assert.equal(plain.code, 0, plain.out + plain.err);
    assert.match(plain.out, /^fetch: 1 pinned in requirements\.txt; build requirements: none$/m);
    writeFileSync(join(r.work, 'requirements.txt'), Buffer.from([0xff, 0xfe, 0x00]));
    const binary = await r.fetch();
    assert.equal(binary.code, 3);
    assert.match(binary.err, /fetch: requirements\.txt: not UTF-8/);
    const none = await r.fetch('nope.txt');
    assert.equal(none.code, 3);
    assert.match(none.err, /fetch: nope\.txt: no such file in the repo/);
  } finally {
    r.done();
  }
});
