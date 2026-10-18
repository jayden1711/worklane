"""Fixtures for the pip fetch's proofs (docs/test-runs.md "Network"): test/testrun-pip-fetch.test.ts and, on real
systemd, scripts/ci/testrun-pip-real-systemd.sh. No network and no tool beyond Python's standard library: the wheels
and the sdist are made here, and the build backend is a stand-in of a few lines (no setuptools).

  <out>/index/             a flat find-links directory: standin 1.0 and standin-backend 1.0 (wheels), evil 1.0 (an
                           sdist only), standin-tool 1.0 (needs standin, and standin-backend for its extra x),
                           standin-direct 1.0 (needs evil @ <--direct-url, default evil's file:// URL>)
  <out>/simple/<name>/     the same files as a simple index (PEP 503) for a plain HTTP server's directory listing
  <out>/repo/              a repo under test: pyproject.toml whose build backend is in the repo (build_hook.py, the
                           repo's own code) and needs standin-backend; requirements.txt (standin==1.0, then -e .);
                           requirements-sdist.txt (evil==1.0), -tool.txt (standin-tool[x]==1.0), -direct.txt
                           (standin-direct==1.0)
  <out>/planted/           with --planted-url URL: standin 1.0+evil, needing evil @ URL (what a run could plant in
                           the cache)

Canaries: the repo's build_hook.py and evil's evil_hook.py run only when something builds them. Each appends "ran" to
its marker (build_hook: repo-ran beside itself; evil: <out>/markers/evil-ran, or --markers), and with --canary HOST:PORT it
sends "GET /canary-repo" (or /canary-evil) to that address and appends "<label> reached" or "<label> <error> <errno>"
to canary.txt beside itself. Usage: python3 -I testrun-pip-fixtures.py <out> [--canary HOST:PORT] [--markers DIR]
[--direct-url URL] [--planted-url URL]
"""
import base64
import hashlib
import io
import os
import sys
import tarfile
import zipfile

args = sys.argv[1:]
out = os.path.abspath(args.pop(0))
canary = ""
markers = os.path.join(out, "markers")
index = os.path.join(out, "index")
direct_url = "file://" + os.path.join(index, "evil-1.0.tar.gz")
planted_url = ""
while args:
    flag = args.pop(0)
    if flag == "--canary":
        canary = args.pop(0)
    elif flag == "--markers":
        markers = os.path.abspath(args.pop(0))
    elif flag == "--direct-url":
        direct_url = args.pop(0)
    elif flag == "--planted-url":
        planted_url = args.pop(0)
    else:
        sys.exit("unknown argument " + flag)
repo = os.path.join(out, "repo")
for d in (index, repo, markers, os.path.join(repo, "standin_repo")):
    os.makedirs(d, exist_ok=True)
os.chmod(markers, 0o777)

# The stand-in build backend (PEP 517 and PEP 660): a wheel of the project's package, or an editable one (a .pth).
BACKEND = '''import base64, hashlib, os, tomllib, zipfile


def _project():
    with open("pyproject.toml", "rb") as f:
        p = tomllib.load(f)["project"]
    return p["name"], p["version"]


def _wheel(directory, files):
    name, version = _project()
    n = name.replace("-", "_")
    dist = n + "-" + version + ".dist-info"
    files = dict(files)
    files[dist + "/METADATA"] = "Metadata-Version: 2.1\\nName: " + name + "\\nVersion: " + version + "\\n"
    files[dist + "/WHEEL"] = "Wheel-Version: 1.0\\nGenerator: standin\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n"
    record = []
    for path, text in files.items():
        data = text.encode()
        digest = base64.urlsafe_b64encode(hashlib.sha256(data).digest()).rstrip(b"=").decode()
        record.append(path + ",sha256=" + digest + "," + str(len(data)))
    record.append(dist + "/RECORD,,")
    files[dist + "/RECORD"] = "\\n".join(record) + "\\n"
    filename = n + "-" + version + "-py3-none-any.whl"
    with zipfile.ZipFile(os.path.join(directory, filename), "w") as z:
        for path, text in files.items():
            z.writestr(path, text)
    return filename


def get_requires_for_build_wheel(config_settings=None):
    return []


def get_requires_for_build_editable(config_settings=None):
    return []


def build_wheel(wheel_directory, config_settings=None, metadata_directory=None):
    pkg = _project()[0].replace("-", "_")
    files = {}
    for root, _, names in os.walk(pkg):
        for f in names:
            if f.endswith(".py"):
                with open(os.path.join(root, f)) as h:
                    files[os.path.join(root, f)] = h.read()
    return _wheel(wheel_directory, files)


def build_editable(wheel_directory, config_settings=None, metadata_directory=None):
    return _wheel(wheel_directory, {"_" + _project()[0].replace("-", "_") + "_editable.pth": os.path.abspath(".") + "\\n"})
'''


def hook(label, marker):
    """An in-tree build backend: the canary, then the stand-in backend. marker None: <label>-ran beside it."""
    return f'''import os, socket

_here = os.path.dirname(os.path.abspath(__file__))
try:
    with open({marker!r} or os.path.join(_here, "{label}-ran"), "a") as f:
        f.write("ran\\n")
except OSError:
    pass
if {canary!r}:
    _host, _port = {canary!r}.rsplit(":", 1)
    try:
        _s = socket.create_connection((_host, int(_port)), 3)
        _s.sendall(b"GET /canary-{label} HTTP/1.0\\r\\nHost: canary\\r\\n\\r\\n")
        _s.recv(100)
        _s.close()
        _got = "reached"
    except OSError as e:
        _got = type(e).__name__ + " " + str(e.errno)
    try:
        with open(os.path.join(_here, "canary.txt"), "a") as f:
            f.write("{label} " + _got + "\\n")
    except OSError:
        pass

from standin_backend import *
'''


def pyproject(name, version, backend):
    return f'[build-system]\nrequires = ["standin-backend>=1"]\nbuild-backend = "{backend}"\nbackend-path = ["."]\n\n[project]\nname = "{name}"\nversion = "{version}"\n'


FIXED = (1980, 1, 1, 0, 0, 0)


def wheel(name, version, files, requires=(), into=None):
    n = name.replace("-", "_")
    dist = f"{n}-{version}.dist-info"
    entries = dict(files)
    entries[f"{dist}/METADATA"] = f"Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n" + "".join(f"Requires-Dist: {r}\n" for r in requires)
    entries[f"{dist}/WHEEL"] = "Wheel-Version: 1.0\nGenerator: standin\nRoot-Is-Purelib: true\nTag: py3-none-any\n"
    record = []
    for p, t in entries.items():
        d = base64.urlsafe_b64encode(hashlib.sha256(t.encode()).digest()).rstrip(b"=").decode()
        record.append(f"{p},sha256={d},{len(t.encode())}")
    record.append(f"{dist}/RECORD,,")
    entries[f"{dist}/RECORD"] = "\n".join(record) + "\n"
    path = os.path.join(into or index, f"{n}-{version}-py3-none-any.whl")
    with zipfile.ZipFile(path, "w") as z:
        for p, t in entries.items():
            z.writestr(zipfile.ZipInfo(p, FIXED), t)
    return path


def sdist(name, version, files):
    path = os.path.join(index, f"{name}-{version}.tar.gz")
    with tarfile.open(path, "w:gz") as t:
        for p, c in files.items():
            b = c.encode()
            i = tarfile.TarInfo(f"{name}-{version}/{p}")
            i.size = len(b)
            t.addfile(i, io.BytesIO(b))
    return path


def write(path, text):
    with open(path, "w") as f:
        f.write(text)


simple = {
    "standin": wheel("standin", "1.0", {"standin/__init__.py": "X = 1\n"}),
    "standin-backend": wheel("standin-backend", "1.0", {"standin_backend/__init__.py": BACKEND}),
    # A dependency by name, and one only its extra x needs.
    "standin-tool": wheel("standin-tool", "1.0", {"standin_tool/__init__.py": ""}, ["standin>=1", 'standin-backend>=1; extra == "x"']),
    # A dependency that is a direct reference to evil's sdist: pip would build it.
    "standin-direct": wheel("standin-direct", "1.0", {"standin_direct/__init__.py": ""}, [f"evil @ {direct_url}"]),
    "evil": sdist("evil", "1.0", {
        "PKG-INFO": "Metadata-Version: 2.1\nName: evil\nVersion: 1.0\n",
        "pyproject.toml": pyproject("evil", "1.0", "evil_hook"),
        "evil_hook.py": hook("evil", os.path.join(markers, "evil-ran")),
        "evil/__init__.py": "",
    }),
}
for name, path in simple.items():
    d = os.path.join(out, "simple", name)
    os.makedirs(d, exist_ok=True)
    with open(path, "rb") as src, open(os.path.join(d, os.path.basename(path)), "wb") as dst:
        dst.write(src.read())

write(os.path.join(repo, "pyproject.toml"), pyproject("standin-repo", "0.1", "build_hook"))
write(os.path.join(repo, "build_hook.py"), hook("repo", None))
write(os.path.join(repo, "standin_repo", "__init__.py"), "Y = 2\n")
write(os.path.join(repo, "requirements.txt"), "standin==1.0\n-e .\n")
write(os.path.join(repo, "requirements-sdist.txt"), "evil==1.0\n")
write(os.path.join(repo, "requirements-tool.txt"), "standin-tool[x]==1.0\n")
write(os.path.join(repo, "requirements-direct.txt"), "standin-direct==1.0\n")
# A wheel a run's command could plant in the cache: standin 1.0+evil (a pin of standin==1.0 matches it, and it sorts
# above 1.0), which depends on evil's sdist by a direct reference.
if planted_url:
    os.makedirs(os.path.join(out, "planted"), exist_ok=True)
    wheel("standin", "1.0+evil", {"standin/__init__.py": "X = 666\n"}, [f"evil @ {planted_url}"], into=os.path.join(out, "planted"))
print(out)
