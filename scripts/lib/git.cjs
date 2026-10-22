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

/** The only GIT_CONFIG_COUNT read: a plain decimal 0 to 9999. Any other becomes a value git refuses. */
const CANONICAL_CONFIG_COUNT = /^(?:0|[1-9][0-9]{0,3})$/;
const REFUSED_CONFIG_COUNT = 'refused';

/**
 * `env` (or this process's environment), with the fixed settings on top, and the fixed config after the caller's own
 * GIT_CONFIG_COUNT pairs and at the end of GIT_CONFIG_PARAMETERS (which git reads last). A count that isn't canonical
 * is replaced with one git refuses, so the git fails closed (as src/os/git.ts gitEnv).
 */
const gitEnv = (env) => {
  const out = { ...(env || process.env), ...GIT_FIXED_ENV };
  // Own keys only: an unset value must never be read through Object.prototype (#846).
  const own = (k) => (Object.hasOwn(out, k) ? out[k] : undefined);
  const raw = own('GIT_CONFIG_COUNT');
  if (raw === undefined || CANONICAL_CONFIG_COUNT.test(raw)) {
    let n = raw === undefined ? 0 : Number(raw);
    for (const [k, v] of GIT_FIXED_CONFIG) {
      out[`GIT_CONFIG_KEY_${n}`] = k;
      out[`GIT_CONFIG_VALUE_${n}`] = v;
      n++;
    }
    out.GIT_CONFIG_COUNT = String(n);
  } else out.GIT_CONFIG_COUNT = REFUSED_CONFIG_COUNT;
  const params = own('GIT_CONFIG_PARAMETERS');
  const fixed = GIT_FIXED_CONFIG.map(([k, v]) => `'${k}=${v}'`).join(' ');
  out.GIT_CONFIG_PARAMETERS = params ? `${params} ${fixed}` : fixed;
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
exports.CANONICAL_CONFIG_COUNT = CANONICAL_CONFIG_COUNT;
exports.REFUSED_CONFIG_COUNT = REFUSED_CONFIG_COUNT;
exports.gitEnv = gitEnv;
exports.gitArgs = gitArgs;
exports.isGitCommand = isGitCommand;
exports.gitSpawnSync = gitSpawnSync;
exports.gitExecFileSync = gitExecFileSync;
exports.gitSpawn = gitSpawn;
exports.commandSpawnSync = commandSpawnSync;
exports.commandExecFileSync = commandExecFileSync;
exports.commandSpawn = commandSpawn;
