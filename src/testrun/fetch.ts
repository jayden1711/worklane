// The fetch phase of a test run's setup (docs/test-runs.md "Network"): what a run's lockfile pins, downloaded into its
// cache with network, before any of the repo's code runs; then the project's own install step runs offline, with no
// network, and that is where install scripts and builds run. Built in per ecosystem (npm and pip): a command of the
// project's own could run the repo's code (an .npmrc's node-options or script-shell, a git dependency's prepare, a
// requirements file's -e . or --no-binary), so the fetch is a fixed script of the helper's, never a command from
// tests.yaml.
//
// INVARIANT: npmFetchScript() is the helper's FETCH_NPM (scripts/machine/<cli>-testrun.sh), byte for byte (a test
// checks it); the local host runs this copy. It takes only package.json and the lockfile into a directory of its own
// (no repo config is read), refuses any package that is not an https:// tarball with an integrity hash (git, file:,
// link and workspace packages are built by running scripts), and runs npm ci --ignore-scripts there.
//
// INVARIANT: pipFetchScript() is the helper's FETCH_PIP, byte for byte (a test checks it). pip never sees a file of the
// repo's, nor the run's cache, nor a dependency it wasn't handed by name:
// - the script reads the named requirements files (and each -r they include) and pyproject.toml as data, and keeps only
//   name==version pins (with any --hash) and the repo's build requirements. WHY not pip download -r <the repo's file>:
//   a line of it can run code before anything is downloaded (measured, pip 24.0: `-e .` runs the repo's build backend
//   even with --only-binary=:all:, and a `--no-binary <name>` line overrides the command line's --only-binary and
//   builds that sdist). Anything but a pin, -r and the repo's own directory (-e . or .; built in the offline step) is
//   refused: an option, a URL or direct reference, a range, a name pip would read as a local archive.
// - pip download --only-binary=:all: --no-deps takes them by name, into the fetch's own directory, with PIP_FIND_LINKS
//   (the cache) unset: a run's commands can write the cache, and a wheel planted there whose metadata names
//   `x @ file://<an sdist>` made pip build that sdist during the fetch (measured, pip 24.0). The script follows the
//   dependencies itself, reading each wheel's METADATA as data, round by round, and refuses any direct reference
//   (`name @ url`); pip's own resolver would build one. Then it copies the wheels it chose into the cache.
// A package with no wheel fails the download: the fetch never builds one.

/** The ecosystems with a built-in fetch. */
export const FETCHERS = ['npm', 'pip'] as const;
export type Fetcher = (typeof FETCHERS)[number];

/** The variable a fetched npm cache must be given in, so the offline install step reads the same cache. */
export const NPM_CACHE_ENV = 'npm_config_cache';
/** pip's: the offline step's `pip install --no-index` finds the fetched wheels there (pip reads it as --find-links). */
export const PIP_CACHE_ENV = 'PIP_FIND_LINKS';
/** Each fetcher's cache variable. */
export const FETCH_CACHE_ENV: Record<Fetcher, string> = { npm: NPM_CACHE_ENV, pip: PIP_CACHE_ENV };
/** The most requirements files one pip fetch names (each -r they include is read too). */
export const MAX_REQUIREMENTS = 8;

/**
 * Why a requirements file's path can't go to the helper (null when it can): relative, inside the repo, no `.` or `..`
 * part, and only characters no shell or systemd expands. The helper checks the same (a test keeps them alike).
 */
export function requirementsFileProblem(p: string): string | null {
  if (!/^[A-Za-z0-9._@+][A-Za-z0-9._@+/-]{0,199}$/.test(p)) return 'a path inside the repo: letters, digits and . _ @ + / - only (at most 200)';
  if (`/${p}/`.includes('//') || `/${p}/`.includes('/./') || `/${p}/`.includes('/../')) return 'a path inside the repo, with no empty, . or .. part';
  return null;
}

/** The fetcher and cache of a tests.yaml fetch entry, and the requirements files a pip one reads. */
export function fetchSpec(f: { npm: string } | { pip: string; requirements: string[] }): { fetcher: Fetcher; cache: string; files: string[] } {
  return 'npm' in f ? { fetcher: 'npm', cache: f.npm, files: [] } : { fetcher: 'pip', cache: f.pip, files: f.requirements };
}

const NPM_FETCH = [
  "set -euo pipefail",
  "w=\"$1\"",
  "mkdir -p -- \"$HOME\"",
  "for f in package.json package-lock.json npm-shrinkwrap.json; do",
  "  if [ -L \"$w/$f\" ]; then echo \"fetch: $f is a symlink: the fetch takes regular files only\" >&2; exit 3; fi",
  "done",
  "[ -f \"$w/package.json\" ] || { echo \"fetch: no package.json at the root of the repo\" >&2; exit 3; }",
  "lock=package-lock.json",
  "if [ -f \"$w/npm-shrinkwrap.json\" ]; then lock=npm-shrinkwrap.json; fi",
  "[ -f \"$w/$lock\" ] || { echo \"fetch: no package-lock.json: the fetch takes only what a lockfile pins\" >&2; exit 3; }",
  "cp -- \"$w/package.json\" package.json",
  "cp -- \"$w/$lock\" \"$lock\"",
  "node - \"$lock\" <<\"JS\"",
  "const fs = require(\"fs\");",
  "const file = process.argv[process.argv.length - 1];",
  "const no = (m) => { console.error(`fetch: ${file}: ${m}`); process.exit(3); };",
  "let j = null;",
  "try { j = JSON.parse(fs.readFileSync(file, \"utf8\")); } catch { no(\"not JSON\"); }",
  "if (!j || ![2, 3].includes(j.lockfileVersion) || !j.packages || typeof j.packages !== \"object\") no(\"needs lockfileVersion 2 or 3 (npm 7 and later), with its packages\");",
  "for (const [k, p] of Object.entries(j.packages)) {",
  "  if (k === \"\") continue;",
  "  if (!p || typeof p !== \"object\") no(`${k}: not a package entry`);",
  "  if (p.link) no(`${k} is a link (a workspace or a file: dependency): the fetch takes registry tarballs only`);",
  "  if (p.inBundle) continue;",
  "  if (typeof p.resolved !== \"string\" || !p.resolved.startsWith(\"https://\")) no(`${k} resolves to ${JSON.stringify(p.resolved ?? null).slice(0, 200)}: the fetch takes https:// tarballs only (git, file: and http: dependencies are built by running their scripts, or not pinned)`);",
  "  if (typeof p.integrity !== \"string\" || !/^sha(256|384|512)-/.test(p.integrity)) no(`${k} has no integrity hash`);",
  "}",
  "JS",
  "npm ci --ignore-scripts --no-audit --no-fund --no-update-notifier --prefer-offline --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=10000",
  "rm -rf node_modules",
  "echo \"fetch: every package $lock pins is in the cache\"",
];

/**
 * The helper's FETCH_NPM, run in a directory of the fetch's own (the helper's: its unit's private /tmp, which no run's
 * command can reach), with HOME under it; its first argument is the workspace, which it only reads.
 */
export function npmFetchScript(): string {
  return NPM_FETCH.join('\n');
}

// WHY String.raw: the Python's regular expressions keep their backslashes. No ' in it (the helper's copy is
// single-quoted: \x27 in a pattern is one), no ${ and no backtick (this is a template literal).
const PIP_FETCH = String.raw`set -euo pipefail
w="$1"
shift
mkdir -p -- "$HOME"
[ "$#" -ge 1 ] || { echo "fetch: no requirements file named" >&2; exit 3; }
python3 -I -c "import tomllib" 2> /dev/null || { echo "fetch: needs python3 3.11 or later (it reads pyproject.toml with tomllib)" >&2; exit 3; }
python3 -I -m pip --version > /dev/null 2>&1 || { echo "fetch: no pip for python3 on this machine (apt-get install python3-pip)" >&2; exit 3; }
python3 -I - "$w" "$@" <<"PY"
import email.parser, os, re, shutil, stat, subprocess, sys, tomllib, zipfile
w = os.path.realpath(sys.argv[1])
def no(m, code=3):
    print("fetch: " + m, file=sys.stderr, flush=True)
    sys.exit(code)
try:
    from pip._vendor.packaging.requirements import InvalidRequirement, Requirement
    from pip._vendor.packaging.specifiers import SpecifierSet
    from pip._vendor.packaging.utils import canonicalize_name, parse_wheel_filename
except ImportError:
    no("this pip has no packaging module of its own (pip._vendor.packaging), which the fetch reads requirements with")
cache = os.environ.pop("PIP_FIND_LINKS", "")
if not cache or not os.path.isdir(cache) or os.path.islink(cache):
    no("no cache directory in PIP_FIND_LINKS")
N = r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?"
X = r"(?:\[ *(?:" + N + r"(?: *, *" + N + r")*)? *\])?"
V = r"(?:[0-9]+!)?[0-9]+(?:\.[0-9]+)*(?:[-_.]?(?:a|b|c|rc|alpha|beta|pre|preview)[0-9]*)?(?:[-_.]?(?:post|rev|r)[0-9]*)?(?:[-_.]?dev[0-9]*)?(?:\+[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)*)?"
M = r"[A-Za-z0-9_.<>=!~()\x22\x27 ,+-]+"
S = r"(?:===|==|!=|<=|>=|~=|<|>) *[A-Za-z0-9*][A-Za-z0-9.*+!_-]*"
PIN = re.compile("(" + N + r") *(" + X + r") *(===?) *(" + V + r") *(?:; *(" + M + "))?", re.I)
REQ = re.compile("(" + N + r") *(" + X + r") *(\(? *(?:" + S + r"(?: *, *" + S + r")*)? *\)?) *(?:; *(" + M + "))?", re.I)
HASH = re.compile(r"sha256:[0-9a-f]{64}|sha384:[0-9a-f]{96}|sha512:[0-9a-f]{128}")
ARCHIVE = re.compile(r"\.(?:whl|zip|tar|tar\.gz|tgz|tar\.bz2|tbz|tar\.xz|txz|tlz|tar\.lz|tar\.lzma)$", re.I)
def archive(r):
    return ARCHIVE.search(r.split(";")[0].strip()) is not None
def rel(p):
    return os.path.relpath(p, w)
def inside(base, r, what):
    p = os.path.normpath(os.path.join(base, r))
    if r.startswith("/") or (p != w and not p.startswith(w + os.sep)):
        no(what + r + ": not a path inside the repo")
    if os.path.realpath(p) != p:
        no(what + r + ": a symlink, or under one (the fetch reads regular files of the repo only)")
    return p
def text(p):
    try:
        st = os.lstat(p)
    except OSError:
        no(rel(p) + ": no such file in the repo")
    if not stat.S_ISREG(st.st_mode):
        no(rel(p) + ": not a regular file")
    if st.st_size > 1048576:
        no(rel(p) + ": over 1 MB")
    with open(p, "rb") as f:
        b = f.read()
    try:
        return b.decode("utf-8-sig")
    except UnicodeDecodeError:
        no(rel(p) + ": not UTF-8")
pins, dirs, seen = [], [w], set()
def local(r, where):
    m = re.fullmatch(r"(\.[A-Za-z0-9._/@+-]*)(\[[A-Za-z0-9._, -]*\])?", r)
    if not m:
        no(where + r + ": not a directory of the repo (./<path>): the fetch takes pins from the index, and the repo itself as -e . or .")
    d = inside(w, m.group(1), where)
    if not os.path.isdir(d):
        no(where + r + ": no such directory in the repo")
    dirs.append(d)
def operand(t, short, long, where):
    if t[0] in (short, long):
        if len(t) != 2:
            no(where + t[0] + " takes one path")
        return t[1]
    v = t[0][len(long) + 1:] if t[0].startswith(long + "=") else t[0][len(short):]
    if len(t) != 1 or not v:
        no(where + t[0] + " takes one path")
    return v
def parse(p, depth):
    if p in seen:
        return
    if depth > 8 or len(seen) >= 64:
        no(rel(p) + ": too many requirements files, or nested too deep (-r)")
    seen.add(p)
    buf, start, items = None, 0, []
    for k, l in enumerate(text(p).splitlines(), 1):
        if l.endswith("\\") and not re.match(r"\s*#", l):
            if buf is None:
                buf, start = "", k
            buf += l[:-1]
            continue
        if buf is not None:
            items.append((start, buf + l))
            buf = None
        else:
            items.append((k, l))
    if buf is not None:
        items.append((start, buf))
    for k, l in items:
        line(p, depth, k, re.sub(r"(^|\s+)#.*$", "", l).strip())
def line(p, depth, k, l):
    where = rel(p) + " line " + str(k) + ": "
    if not l:
        return
    if re.search(r"[\x00-\x08\x0a-\x1f\x7f]", l):
        no(where + "a control character")
    t = l.split()
    if t[0] in ("-r", "--requirement") or t[0].startswith("--requirement=") or re.match(r"-r[^-]", t[0]):
        parse(inside(os.path.dirname(p), operand(t, "-r", "--requirement", where), where), depth + 1)
        return
    if t[0] in ("-e", "--editable") or t[0].startswith("--editable=") or re.match(r"-e[^-]", t[0]):
        local(operand(t, "-e", "--editable", where), where)
        return
    if t[0].startswith("-"):
        no(where + t[0] + ": an option the fetch does not take (only pins, -r and the repo itself as -e .): an index, find-links or binary option changes where pip downloads from, or makes it build an sdist, which runs its code")
    j = next((i for i, s in enumerate(t) if s.startswith("-")), len(t))
    r, opts = " ".join(t[:j]), t[j:]
    if r.startswith(".") and not opts:
        local(r, where)
        return
    if re.search(r"[/:@$]", r):
        no(where + r + ": a URL, path or direct reference: the fetch takes pins of name==version from the index only")
    if archive(r):
        no(where + r + ": pip would read it as an archive file: the fetch takes pins of name==version from the index only")
    m = PIN.fullmatch(r)
    if not m:
        no(where + r + ": not a pin: the fetch takes name==version only, as pip-compile, uv pip compile or pip freeze write it")
    h, i = [], 0
    while i < len(opts):
        o, v = opts[i], None
        if o == "--hash" and i + 1 < len(opts):
            v, i = opts[i + 1], i + 2
        elif o.startswith("--hash="):
            v, i = o[7:], i + 1
        if v is None or not HASH.fullmatch(v):
            no(where + o + ": the only option a pin may have is --hash=sha256:<hex> (or sha384, sha512)")
        h.append(v)
    s = m.group(1) + m.group(2).replace(" ", "") + m.group(3) + m.group(4)
    if m.group(5):
        s += " ; " + m.group(5).strip()
    pins.append((s, h))
for a in sys.argv[2:]:
    parse(inside(w, a, ""), 0)
def toml(p):
    try:
        return tomllib.loads(text(p))
    except tomllib.TOMLDecodeError as e:
        no(rel(p) + ": not TOML (" + str(e) + ")")
build = []
for d in dict.fromkeys(dirs):
    pp = os.path.join(d, "pyproject.toml")
    data = toml(inside(d, "pyproject.toml", "")) if os.path.lexists(pp) else None
    bs = data.get("build-system") if data is not None else None
    if bs is not None:
        r = bs.get("requires", []) if isinstance(bs, dict) else None
        if not isinstance(r, list) or not all(isinstance(x, str) for x in r):
            no(rel(pp) + ": build-system.requires is not a list of strings")
        for x in r:
            x = x.strip()
            if re.search(r"[\x00-\x1f\x7f]", x):
                no(rel(pp) + ": build requirement " + repr(x) + ": a control character")
            if re.search(r"[/:@$]", x) or re.search(r"(^| )-", x) or archive(x) or not REQ.fullmatch(x):
                no(rel(pp) + ": build requirement " + x + ": the fetch takes a name and version ranges from the index only (no URL, direct reference or archive file)")
            build.append(x)
    elif data is not None or os.path.lexists(os.path.join(d, "setup.py")) or os.path.lexists(os.path.join(d, "setup.cfg")):
        build += ["setuptools>=40.8.0", "wheel"]
build = list(dict.fromkeys(build))
print("fetch: " + str(len(pins)) + " pinned in " + ", ".join(sys.argv[2:]) + "; build requirements: " + (", ".join(build) or "none"), flush=True)
# What to download: each package by its canonical name, with every range asked of it so far, the extras asked of it,
# and its pin (line and hashes) when the requirements pin it.
want, got = {}, {}
def add(name, spec, extras, why, pin=None):
    if not re.fullmatch(N, name) or archive(name):
        no(why + ": " + name + ": not a package name the fetch takes")
    k = canonicalize_name(name)
    v = want.setdefault(k, {"name": name, "spec": SpecifierSet(), "extras": set(), "pin": None, "why": why})
    if pin:
        v["pin"] = pin
    v["spec"] &= spec
    v["extras"] |= set(extras)
def req(s, why):
    try:
        return Requirement(s)
    except InvalidRequirement as e:
        no(why + ": " + s[:200] + ": not a requirement pip reads (" + str(e)[:200] + ")")
for s, h in pins:
    r = req(s, "a pin")
    if r.marker is None or r.marker.evaluate():
        add(r.name, r.specifier, r.extras, "pinned " + s, (s, h))
for s in build:
    r = req(s, "a build requirement")
    if r.marker is None or r.marker.evaluate():
        add(r.name, r.specifier, r.extras, "the build requirement " + s)
# Its dependencies, read from its METADATA as data. A direct reference is refused: pip would build it.
def scan(k):
    ver, path, _ = got[k]
    v = want[k]
    base = os.path.basename(path)
    with zipfile.ZipFile(path) as z:
        meta = [n for n in z.namelist() if n.count("/") == 1 and n.endswith(".dist-info/METADATA")]
        if len(meta) != 1 or z.getinfo(meta[0]).file_size > 1048576:
            no(base + ": no single METADATA of at most 1 MB")
        m = email.parser.Parser().parsestr(z.read(meta[0]).decode("utf-8", "replace"))
    for d in m.get_all("Requires-Dist") or []:
        r = req(d, base + " depends on")
        if r.url:
            no(base + " depends on " + r.name + " @ " + r.url[:200] + ": a direct reference, which pip would build: the fetch takes packages from the index only")
        if r.marker is not None and not any(r.marker.evaluate({"extra": e}) for e in v["extras"] | {""}):
            continue
        add(r.name, r.specifier, r.extras, base + " needs " + d.strip()[:200])
    got[k] = (ver, path, set(v["extras"]))
dl = os.path.abspath("wheels")
for rnd in range(1, 41):
    todo = [k for k, v in want.items() if k not in got or not v["spec"].contains(got[k][0], prereleases=True)]
    rescan = [k for k, v in want.items() if k in got and k not in todo and not v["extras"] <= got[k][2]]
    if not todo and not rescan:
        break
    files = {"hashed": [], "plain": []}
    for k in todo:
        v = want[k]
        if v["pin"] and k in got:
            no(v["why"] + ": a dependency needs " + v["name"] + str(v["spec"]) + ", which the pin excludes")
        if v["pin"]:
            files["hashed" if v["pin"][1] else "plain"].append(v["pin"][0] + "".join(" --hash=" + x for x in v["pin"][1]))
        else:
            files["plain"].append(v["name"] + str(v["spec"]))
    d = os.path.join(dl, str(rnd))
    os.makedirs(d)
    for kind, lines in files.items():
        if not lines:
            continue
        f = "round-" + str(rnd) + "-" + kind + ".txt"
        with open(f, "w") as o:
            o.write("".join(x + "\n" for x in lines))
        if subprocess.run(["python3", "-I", "-m", "pip", "download", "--only-binary=:all:", "--no-deps", "--no-cache-dir", "--disable-pip-version-check", "--no-input", "--progress-bar", "off", "--dest", d, "-r", f]).returncode != 0:
            no("pip download failed: the fetch takes wheels only (building an sdist runs its code), so a package with no wheel for this Python and platform is refused; if that is why, grant the setup steps the network instead (docs/test-runs.md, Network)", 4)
    for f in sorted(os.listdir(d)):
        p = os.path.join(d, f)
        if not f.endswith(".whl") or os.path.islink(p) or not os.path.isfile(p):
            no("pip download saved " + f + ", not a wheel")
        name, ver, _, _ = parse_wheel_filename(f)
        if canonicalize_name(name) not in todo:
            no("pip download saved " + f + ", which the fetch did not ask for")
        got[canonicalize_name(name)] = (ver, p, set())
    for k in todo:
        if k not in got or not want[k]["spec"].contains(got[k][0], prereleases=True):
            no("pip download gave no wheel of " + want[k]["name"] + str(want[k]["spec"]) + " (" + want[k]["why"] + ")", 4)
    for k in todo + rescan:
        scan(k)
else:
    no("the dependencies did not settle in 40 rounds")
# Into the cache: only the wheels chosen, each a new file (one a run command put there, or a symlink, is replaced).
for k in sorted(got):
    src = got[k][1]
    dst = os.path.join(cache, os.path.basename(src))
    try:
        os.unlink(dst)
    except FileNotFoundError:
        pass
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with open(src, "rb") as a, os.fdopen(fd, "wb") as b:
        shutil.copyfileobj(a, b)
print("fetch: " + str(len(got)) + " wheels into the cache: " + (", ".join(os.path.basename(got[k][1]) for k in sorted(got)) or "none"))
PY
echo "fetch: every pinned package and build requirement is in the cache, as wheels"`;

/**
 * The helper's FETCH_PIP, run as FETCH_NPM is: its first argument the workspace, then the requirements files. The
 * cache is PIP_FIND_LINKS, which the script unsets before pip runs.
 */
export function pipFetchScript(): string {
  return PIP_FETCH;
}

/** Each fetcher's script. */
export function fetchScript(f: Fetcher): string {
  return f === 'npm' ? npmFetchScript() : pipFetchScript();
}
