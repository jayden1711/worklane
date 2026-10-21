'use strict';
// The one way scripts/ runs git (#807): the engine runner's settings (src/os/git.ts) for scripts, which run without a
// build. Every git process runs with replace refs off (`--no-replace-objects`, GIT_NO_REPLACE_OBJECTS=1) and reads no
// graft file (GIT_GRAFT_FILE names a path that can't exist), set last over the caller's environment.
// test/git-runner.test.ts checks these are the engine's settings, and fails on a git call in scripts/ that doesn't
// come through here. CommonJS, so a .cjs script can require it and a .mjs script can import it.
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { devNull } = require('node:os');
const { join } = require('node:path');

const GIT_FIXED_ARGS = Object.freeze(['--no-replace-objects', '-c', 'core.commitGraph=false']);
const GIT_FIXED_ENV = Object.freeze({ GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: join(devNull, 'no-grafts') });
/** git config every git also gets through its environment (GIT_CONFIG_COUNT pairs), after the caller's own pairs. */
const GIT_FIXED_CONFIG = Object.freeze([Object.freeze(['core.commitGraph', 'false'])]);

/** `env` (or this process's environment), with the fixed settings on top and the fixed config pairs after its own. */
const gitEnv = (env) => {
  const out = { ...(env || process.env), ...GIT_FIXED_ENV };
  let n = Number(out.GIT_CONFIG_COUNT === undefined ? '0' : out.GIT_CONFIG_COUNT);
  if (!Number.isSafeInteger(n) || n < 0) n = 0;
  for (const [k, v] of GIT_FIXED_CONFIG) {
    out[`GIT_CONFIG_KEY_${n}`] = k;
    out[`GIT_CONFIG_VALUE_${n}`] = v;
    n++;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
};
/** The argument list a git process gets: the fixed arguments, then `args`. */
const gitArgs = (args) => [...GIT_FIXED_ARGS, ...args];
/** True for a command that runs git: `git`, or a path to it, in any case. */
const isGitCommand = (cmd) => ['git', 'git.exe'].includes((String(cmd).split(/[\\/]/).pop() || '').toLowerCase());

/** spawnSync of git. */
const gitSpawnSync = (args, options = {}) => spawnSync('git', gitArgs(args), { ...options, env: gitEnv(options.env) });
/** execFileSync of git. */
const gitExecFileSync = (args, options = {}) => execFileSync('git', gitArgs(args), { ...options, env: gitEnv(options.env) });
/** spawn of git. */
const gitSpawn = (args, options = {}) => spawn('git', gitArgs(args), { ...options, env: gitEnv(options.env) });
/** spawnSync of a command named at run time: git (by name or path) with the settings, anything else as it is. */
const commandSpawnSync = (cmd, args, options = {}) => (isGitCommand(cmd) ? spawnSync(cmd, gitArgs(args), { ...options, env: gitEnv(options.env) }) : spawnSync(cmd, args, options));
/** execFileSync of a command named at run time: git (by name or path) with the settings, anything else as it is. */
const commandExecFileSync = (cmd, args, options = {}) => (isGitCommand(cmd) ? execFileSync(cmd, gitArgs(args), { ...options, env: gitEnv(options.env) }) : execFileSync(cmd, args, options));
/** spawn of a command named at run time: git (by name or path) with the settings, anything else as it is. */
const commandSpawn = (cmd, args, options = {}) => (isGitCommand(cmd) ? spawn(cmd, gitArgs(args), { ...options, env: gitEnv(options.env) }) : spawn(cmd, args, options));

exports.GIT_FIXED_ARGS = GIT_FIXED_ARGS;
exports.GIT_FIXED_ENV = GIT_FIXED_ENV;
exports.GIT_FIXED_CONFIG = GIT_FIXED_CONFIG;
exports.gitEnv = gitEnv;
exports.gitArgs = gitArgs;
exports.isGitCommand = isGitCommand;
exports.gitSpawnSync = gitSpawnSync;
exports.gitExecFileSync = gitExecFileSync;
exports.gitSpawn = gitSpawn;
exports.commandSpawnSync = commandSpawnSync;
exports.commandExecFileSync = commandExecFileSync;
exports.commandSpawn = commandSpawn;
