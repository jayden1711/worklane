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
// A command gone from this list is a command the launch lint no longer catches: never-shrink.
// check-table: never-shrink
export const DARWIN_ARM64_COMMANDS = [
  'agents',
  'apply-project-settings',
  'attach',
  'auth',
  'auto-mode',
  'bridge',
  'daemon',
  'design-login',
  'doctor',
  'drop-worktree-registrations',
  'edit-chrome-settings',
  'edit-hook',
  'edit-memory-settings',
  'edit-permission-rules',
  'edit-sandbox-settings',
  'edit-skill-overrides',
  'gateway',
  'import',
  'import-conversations',
  'install',
  'kill',
  'logs',
  'mcp',
  'plugin',
  'plugins',
  'project',
  'purge',
  'rc',
  'remote',
  'remote-control',
  'respawn',
  'rm',
  'sandbox',
  'self-hosted-runner',
  'setup-token',
  'stop',
  'sync',
  'ultrareview',
  'update',
  'upgrade',
];
