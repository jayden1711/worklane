#!/usr/bin/env bash
# CI only (.github/workflows/release.yml): the dry run of staging the package on npm.
#   bash scripts/ci/npm-stage-dry-run.sh <tarball>
# WHY: `npm stage publish --dry-run` checks the registry, and refuses a version that is already published ("You
# cannot publish over the previously published versions"). Between releases package.json still names the last one,
# so on a pull request that one refusal, for exactly that version, and only while the registry really holds it, is
# reported and accepted: the dry run has checked the rest. Anything else fails. Never stages, publishes or tags.
set -euo pipefail
tgz="$1"
name="$(tar -xzOf "$tgz" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).name')"
version="$(tar -xzOf "$tgz" package/package.json | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version')"
code=0
out="$(npm stage publish "$tgz" --dry-run --access public 2>&1)" || code=$?
printf '%s\n' "$out"
[ "$code" = 0 ] && exit 0
if printf '%s\n' "$out" | grep -qF "You cannot publish over the previously published versions: ${version}." \
  && [ "$(npm view "${name}@${version}" version 2>/dev/null)" = "$version" ]; then
  echo "${name}@${version} is already on the registry, so npm won't stage it again; the rest of the dry run passed (the next version stages)"
  exit 0
fi
exit "$code"
