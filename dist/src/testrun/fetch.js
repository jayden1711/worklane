// The fetch phase of a test run's setup (docs/test-runs.md "Network"): what a run's lockfile pins, downloaded into its
// cache with network, before any of the repo's code runs; then the project's own install step runs offline, with no
// network, and that is where install scripts run. Built in per ecosystem (npm only, for now): a command of the
// project's own could run the repo's code (an .npmrc's node-options or script-shell, a git dependency's prepare), so
// the fetch is a fixed script of the helper's, never a command from tests.yaml.
//
// INVARIANT: npmFetchScript() is the helper's FETCH_NPM (scripts/machine/<cli>-testrun.sh), byte for byte (a test
// checks it); the local host runs this copy. It takes only package.json and the lockfile into a directory of its own
// (no repo config is read), refuses any package that is not an https:// tarball with an integrity hash (git, file:,
// link and workspace packages are built by running scripts), and runs npm ci --ignore-scripts there.
/** The ecosystems with a built-in fetch. */
export const FETCHERS = ['npm'];
/** The variable a fetched npm cache must be given in, so the offline install step reads the same cache. */
export const NPM_CACHE_ENV = 'npm_config_cache';
const NPM_FETCH = [
    "set -euo pipefail",
    "w=../work",
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
/** The helper's FETCH_NPM, run in the run's fetch directory (the workspace is ../work). */
export function npmFetchScript() {
    return NPM_FETCH.join('\n');
}
//# sourceMappingURL=fetch.js.map