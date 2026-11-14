// The pinned claude CLI's top-level commands, one entry per platform build, each found by probing every word in that
// binary's bytes (scripts/ci/claude-registry.mjs, R1185as). Written by `node scripts/ci/claude-registry.mjs --write
// <claude>` on that platform: don't edit it by hand. CI checks the installed binary's sha256 against its platform's
// entry and, while it matches, uses that entry's commands without probing again; a new pin fails there until each
// platform's entry is written for it, in the PR that bumps the pin.
export const PROBE_COMMAND = 'node scripts/ci/claude-registry.mjs --write <claude>';

// platform: darwin-arm64
export const DARWIN_ARM64_VERSION = '2.1.296';
export const DARWIN_ARM64_SHA256 = 'c9b5341637becbd423ddffc5b254afb645682a3868cb708bbc6cc0e7bb419937';
export const DARWIN_ARM64_PROBED_AT = '2026-11-12';

// BEGIN tables from claude-commands.tables.json: generated, do not edit (node scripts/gen-table-copies.mjs --write)
// This script runs on its own, so it carries its tables as frozen literals of the data in
// scripts/ci/claude-commands.tables.json, which the weakening hold compares parsed (#941).
// test/table-copies.test.ts fails when this block is not what that file makes.
const DARWIN_ARM64_COMMANDS = Object.freeze(["agents", "apply-project-settings", "attach", "auth", "auto-mode", "bridge", "daemon", "design-login", "doctor", "drop-worktree-registrations", "edit-chrome-settings", "edit-hook", "edit-memory-settings", "edit-permission-rules", "edit-sandbox-settings", "edit-skill-overrides", "gateway", "import", "import-conversations", "install", "kill", "logs", "mcp", "plugin", "plugins", "project", "purge", "rc", "remote", "remote-control", "respawn", "rm", "sandbox", "self-hosted-runner", "setup-token", "stop", "sync", "ultrareview", "update", "upgrade"]);
// END tables from claude-commands.tables.json
