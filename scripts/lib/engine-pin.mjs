// The engine release scripts/bootstrap.sh installs: ENGINE_TAG and ENGINE_COMMIT. Pure: scripts/pin-engine.mjs
// checks the tag and its commit with git, this reads and writes the two lines.

const TAG_LINE = /^ENGINE_TAG=.*$/gm;
const COMMIT_LINE = /^ENGINE_COMMIT=.*$/gm;

/** The pin in a bootstrap.sh: { tag, commit }, commit '' when it isn't filled in (a trailing comment is not a value). */
export function readPin(text) {
  const tag = [...text.matchAll(TAG_LINE)];
  const commit = [...text.matchAll(COMMIT_LINE)];
  if (tag.length !== 1 || commit.length !== 1) throw new Error('bootstrap.sh needs exactly one ENGINE_TAG= line and one ENGINE_COMMIT= line');
  const value = (line) => line.replace(/^[A-Z_]+=/, '').replace(/\s*#.*$/, '').trim();
  return { tag: value(tag[0][0]), commit: value(commit[0][0]) };
}

/** bootstrap.sh pinned to `tag` at `commit` (a full 40-hex commit id); only those two lines change. */
export function writePin(text, tag, commit) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`not a release tag: ${tag}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`not a full commit id: ${commit}`);
  readPin(text);
  return text.replace(TAG_LINE, `ENGINE_TAG=${tag}`).replace(COMMIT_LINE, `ENGINE_COMMIT=${commit}`);
}

/**
 * Why a commit isn't a release commit for `version`, or null: the release script's shape, one commit on top of the
 * main commit it was cut from, adding only the built dist/ (dist/src/cli.js among it), at that package version.
 * facts: { parents: how many, changed: paths it changes against its parent, hasCli, version: package.json's,
 * parentOnMain }. The same shape the release-channel updater requires (scripts/machine/worklane-update.cjs).
 */
export function releaseProblem(version, facts) {
  if (facts.parents !== 1) return `it has ${facts.parents} parents; a release commit has one, the main commit it was cut from`;
  if (!facts.hasCli) return 'it carries no built dist/src/cli.js: not a release commit';
  const other = facts.changed.filter((f) => !f.startsWith('dist/'));
  if (other.length) return `it changes more than dist/ against its parent (${other.slice(0, 5).join(', ')}): not a release commit`;
  if (facts.version !== version) return `its package.json is ${facts.version}, not ${version}`;
  if (!facts.parentOnMain) return "its parent isn't a commit on origin/main: a release is cut from main";
  return null;
}
