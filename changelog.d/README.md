# changelog.d: the next release's notes, one file per change

A PR that needs a release note adds its own file here. It never edits CHANGELOG.md, so two open PRs never touch the
same lines. CHANGELOG.md holds only released sections. The release's changelog step
(`node scripts/release.mjs changelog X.Y.Z`, docs/releasing.md step 1) moves every fragment into the new dated section
and deletes it, in the release PR.

## The file

- **Name:** `changelog.d/<issue or PR number>-<short-slug>.md`, for example `changelog.d/712-tag-refuses-unreleased.md`.
  The number has no leading zero; the slug is lowercase letters, digits and dashes. The release orders fragments by
  that number, then by name.
- **Content:** one or more `### <Heading>` blocks, with the notes under each. The notes are free markdown: bullets,
  nested bullets, paragraphs, code spans. They are copied into the release verbatim, line for line.
- **Headings:** only these, written exactly so (each at most once per file). The release writes them in this order:
  1. `### Upgrading` (or `### Upgrading (from vX.Y.Z)`, spelled the same in every fragment of a release): what an
     existing install sees or must do on upgrade.
  2. `### After install`: root steps to run once the release is installed.
  3. `### Guardrail changes: what each one does`: each guardrail added, removed or changed, and what it does.
  4. `### Release tooling`: changes to how releases are cut.
  5. `### Removals`: what is removed, and what replaces it.

  The headings the release generates itself (Features, Fixes, Security and guardrails, Reverted in this release,
  Guardrail changes) are never a fragment's: the PR lists come from GitHub.

## What the release step refuses

It writes nothing, and deletes nothing, if any fragment line could be dropped or moved:

- a heading that isn't one of the five above, or any other line starting with `#` (up to 3 spaces in): a `##` line
  would start a section of CHANGELOG.md. Indent a `#` line 4 spaces (code) or reword it;
- text before the first heading, a heading with nothing under it, or the same heading twice in one file;
- an empty file, a carriage return (use LF line ends), a file name not shaped `<n>-<slug>.md`, or anything here but
  fragments and this README;
- two spellings of the Upgrading heading across fragments;
- fragments while CHANGELOG.md already has a section for the version (start the release branch again from main).

`test/changelog.test.ts` (the backstop) fails on the same things before merge, and on any `(unreleased)` section in
CHANGELOG.md.

## Example

`changelog.d/712-tag-refuses-unreleased.md`:

```markdown
### Upgrading (from v0.5.2)

- **A release can't be tagged from an undated section (#712).** `release.mjs X.Y.Z` refuses unless CHANGELOG.md has
  `## vX.Y.Z (YYYY-MM-DD)`: run the changelog step and merge it first.

### Release tooling

- The changelog step reads which PRs a revert reverts from its body's `Reverts owner/repo#N` lines (#712).
```
