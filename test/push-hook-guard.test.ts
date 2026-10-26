// The push gate's first-time-setup hatch (PUSH_GATE_BOOTSTRAP) and git's pre-push hook are a person's, never an
// agent's: the guardrails refuse every way an agent's tool call sets, passes or stores the hatch or swaps the hook,
// and no agent or project command starts with the hatch in its environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { BRAND } from '../src/brand.js';
import { GuardrailsConfig, TestsConfig } from '../src/config/schema.js';
import { exampleContext } from '../src/guardrails/check.js';
import { liveContext } from '../src/guardrails/context.js';
import { evaluate } from '../src/guardrails/engine.js';
import { PUSH_GATE_HATCH_ENV, withoutPushGateHatch } from '../src/guardrails/push-hook.js';
import { runHook } from '../src/hook.js';
import { childEnv, projectCommand } from '../src/os/index.js';
import { projectEnvProblem, safeProjectEnv } from '../src/project-env.js';
import { agentEnv, runAsEnv } from '../src/runner.js';
import { exampleProject, repoRoot } from './helpers.js';

const cfg = GuardrailsConfig.parse({ version: 1 });
const verdict = (tool: string, input: Record<string, unknown>, agent = true, cwd = '/p') => evaluate({ tool, input, cwd }, cfg, exampleContext(cfg, '/p', agent));
const bash = (command: string, agent = true, cwd = '/p') => verdict('Bash', { command }, agent, cwd);
const H = PUSH_GATE_HATCH_ENV;

test('the hatch has the name the push gate hook reads, and the hook knows the agent marker the runner sets', () => {
  const hook = readFileSync(join(repoRoot, 'scripts', 'push-gate-hook.mjs'), 'utf8');
  assert.match(hook, new RegExp(`^const HATCH = '${H}';$`, 'm'));
  assert.match(hook, new RegExp(`^const AGENT_MARKER = '${BRAND.envPrefix}_AGENT';$`, 'm'));
  assert.equal(agentEnv({}, 'cli')[`${BRAND.envPrefix}_AGENT`], '1');
});

test('an agent may not set, export or pass the hatch, in any wrapper', () => {
  for (const c of [
    `${H}=1 git push origin HEAD`,
    `${H}=1 git push`,
    `${H}=1`,
    `export ${H}=1`,
    `export ${H}=1 && git push`,
    `export ${H}; ${H}=1; git push`,
    `declare -x ${H}=1; git push`,
    `env ${H}=1 git push`,
    `/usr/bin/env ${H}=1 git push origin HEAD:refs/heads/x`,
    `sudo env ${H}=1 git push`,
    `sh -c '${H}=1 git push'`,
    `bash -lc "export ${H}=1; git push"`,
    `zsh -c 'env ${H}=1 git push'`,
    `eval "${H}=1 git push"`,
    `echo $(${H}=1 git push)`,
    `(${H}=1 git push)`,
    `{ ${H}=1 git push; }`,
    `git status && ${H}=1 git push`,
    `timeout 60 env ${H}=1 git push`,
    `xargs env ${H}=1 git push < /dev/null`,
    `${H.toLowerCase()}=1 git push`,
    `"PUSH_GATE_BOOT""STRAP"=1 git push`,
    `export PUSH_GATE_BOOT\\STRAP=1`,
    `set -a; ${H}=1; set +a; git push`,
    `fish -c 'set -x ${H} 1; git push'`,
    `node -e "process.env.${H}='1'; require('child_process').execSync('git push')"`,
    `python3 -c "import os; os.environ['${H}']='1'; os.system('git push')"`,
    `npm_config_x=1 npm run push --${H}=1`,
    `git -c alias.p='!${H}=1 git push' p`,
    `git -c core.pager='${H}=1 git push' log`,
    `rg --pre 'env ${H}=1 git push' x`,
    `grep -rn ${H} docs && git push`,
  ]) assert.deepEqual([bash(c).decision, bash(c).rule], ['deny', 'push-gate-hatch'], c);
});

test('an agent may not store the hatch where a later shell or push would read it', () => {
  for (const c of [
    `echo 'export ${H}=1' >> ~/.zshrc`,
    `echo ${H}=1 >> .env`,
    `printf '${H}=1\\n' | tee -a ~/.bashrc`,
    `echo ${H}=1 | sudo tee -a /etc/environment`,
    `cat >> ~/.profile <<EOF\nexport ${H}=1\nEOF`,
    `sed -i 's/^#x/export ${H}=1/' ~/.zshenv`,
    `git config --global alias.p '!${H}=1 git push'`,
    `git config core.sshCommand '${H}=1 ssh'`,
    `launchctl setenv ${H} 1`,
    `echo '${H}=1 git push' > push.sh`,
  ]) assert.deepEqual([bash(c).decision, bash(c).rule], ['deny', 'push-gate-hatch'], c);
  const write = (file_path: string, content: string, agent = true) => verdict('Write', { file_path, content }, agent);
  for (const f of ['/home/example/.zshrc', '/home/example/.bashrc', '/home/example/.profile', '/p/.env', '/p/.env.local', '/p/ci.env', '/p/.envrc', '/home/example/.config/fish/config.fish', '/home/example/.config/environment.d/x.conf', '/etc/environment', '/etc/profile.d/x.sh']) {
    assert.deepEqual([write(f, `export ${H}=1\n`).decision, write(f, `export ${H}=1\n`).rule], ['deny', 'push-gate-hatch'], f);
  }
  assert.equal(verdict('Edit', { file_path: '.env', old_string: 'A=1', new_string: `A=1\n${H}=1` }).rule, 'push-gate-hatch');
  assert.equal(verdict('MultiEdit', { file_path: '/p/.env', edits: [{ old_string: 'A=1', new_string: `${H}=1` }] }).rule, 'push-gate-hatch');
  assert.equal(write('/p/.env.local', 'WORKERS=4\n').decision, 'none', 'an env file without the hatch');
});

test('an agent may not skip or swap the pre-push hook', () => {
  for (const c of [
    'git push --no-verify',
    'git push --no-verify origin HEAD:refs/heads/x',
    'git -C . push origin HEAD --no-verify',
    'git -c core.hooksPath=/dev/null push',
    'git -c core.hookspath=/tmp/h push origin HEAD',
    'git -ccore.hooksPath=/tmp/h push',
    'git -C /p -c core.hooksPath= push',
    'H=/tmp/h git --config-env=core.hooksPath=H push',
    'git --config-env core.hooksPath=H push',
    'git config core.hooksPath /tmp/h',
    'git config --local core.hooksPath .githooks',
    'git config --global core.hooksPath /tmp/h',
    'git config set core.hooksPath /tmp/h',
    'git config --unset core.hooksPath',
    'git config --worktree core.hooksPath /tmp/h',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/h git push',
    'export GIT_CONFIG_KEY_3=core.hooksPath',
    "GIT_CONFIG_PARAMETERS=\"'core.hooksPath=/tmp/h'\" git push",
    'GIT_CONFIG_GLOBAL=/tmp/cfg git push',
    'env GIT_CONFIG_SYSTEM=/tmp/cfg git push origin HEAD',
    'export GIT_CONFIG_GLOBAL=/tmp/cfg; git push',
    "sh -c 'git -c core.hooksPath=/dev/null push'",
    "bash -c 'git push --no-verify'",
    'rm .git/hooks/pre-push',
    'rm -rf .git/hooks',
    'mv .git/hooks .git/hooks.off',
    'echo "exit 0" > .git/hooks/pre-push',
    'cp /tmp/pre-push .git/hooks',
    'chmod -x .git/hooks/pre-push; touch .git/hooks/pre-push',
    'ln -sf /usr/bin/true .git/hooks/pre-push',
    'echo "exit 0" > /repo/.git/worktrees/a/hooks/pre-push',
    'sed -i s/x/y/ .git/hooks/push-gate-hook.mjs',
    'printf "[core]\\n\\thooksPath = /tmp/h\\n" >> .git/config',
    'echo "[core]" >> ~/.gitconfig',
    'tee -a ~/.config/git/config < /tmp/cfg',
    'echo x >> .git/config.worktree',
  ]) assert.deepEqual([bash(c).decision, bash(c).rule], ['deny', 'push-hook-bypass'], c);
  // A relative write from inside the git dir.
  assert.equal(bash('echo "exit 0" > hooks/pre-push', true, '/p/.git').rule, 'push-hook-bypass');
  assert.equal(bash('echo x > pre-push', true, '/p/.git/hooks').rule, 'push-hook-bypass');
  for (const f of ['/p/.git/hooks/pre-push', '.git/hooks/push-gate-hook.mjs', '/p/.git/config', '/home/example/.gitconfig', '/home/example/.config/git/config', '/p/.git/worktrees/a/config.worktree']) {
    assert.equal(verdict('Write', { file_path: f, content: 'x' }).rule, 'push-hook-bypass', f);
    assert.equal(verdict('Edit', { file_path: f, old_string: 'a', new_string: 'b' }).rule, 'push-hook-bypass', f);
  }
});

test('an agent may not skip the pre-push hook in any other spelling git reads (#993)', () => {
  for (const c of [
    // Prefixes of --no-verify git's option parser takes (and shorter ones another git version may).
    'git push --no-verif',
    'git push --no-veri origin HEAD:refs/heads/x',
    'git push origin HEAD --no-ver',
    'git push --no-v',
    // Config that can carry core.hooksPath, or run a push by another name.
    'git -c include.path=/tmp/cfg push',
    'git -c includeIf.gitdir:/.path=/tmp/cfg push origin HEAD',
    'git --config-env=include.path=CFG push',
    "git -c alias.p='push --no-verify' p",
    'git -c alias.p=push p --no-verif',
    "git -c alias.p='-c core.hooksPath=/dev/null push' p",
    'git -c help.autocorrect=immediate psuh --no-verify',
    'git config include.path /tmp/cfg',
    'git config --global includeIf.gitdir:~/.path /tmp/cfg',
    "git config alias.p 'push --no-verify'",
    "git config --global alias.p '!git push --no-verify'",
    'git config set alias.p push',
    'git config help.autocorrect immediate',
    'git config --rename-section x core',
    'git config --remove-section core',
    'git config --edit',
    'git config -e',
    // Environment that gives a push other config, or another repository's hooks.
    'HOME=/tmp/h git push',
    'XDG_CONFIG_HOME=/tmp/x git push origin HEAD',
    'GIT_CONFIG_NOSYSTEM=1 git push',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=include.path GIT_CONFIG_VALUE_0=/tmp/cfg git push',
    'export GIT_CONFIG_KEY_0=include.path',
    "GIT_CONFIG_PARAMETERS=\"'alias.p=push --no-verify'\" git p",
    'GIT_DIR=/tmp/copy.git git push',
    'GIT_COMMON_DIR=/tmp/copy.git git push',
    'git --git-dir=/tmp/copy.git push origin HEAD',
    'unset HOME; git push',
    'env -i git push',
    'env -u HOME git push',
    'env -u X git push --no-verify',
    // Pushes that never run the hook.
    'git send-pack ../remote.git HEAD:refs/heads/x',
    'git http-push https://example.com/r.git HEAD',
    'git remote-ext origin x',
    '/usr/lib/git-core/git-send-pack ../remote.git HEAD',
    // git run by a program the shell matcher doesn't read.
    'find . -maxdepth 0 -exec git push --no-verify \\;',
  ]) assert.deepEqual([bash(c).decision, bash(c).rule], ['deny', 'push-hook-bypass'], c);
});

test("git's own push and config programs, run by name or path, are read as git push and git config (#993)", () => {
  for (const c of [
    '/usr/lib/git-core/git-push --no-verify origin HEAD',
    '$(git --exec-path)/git-push --no-verify origin HEAD',
    '"$(git --exec-path)/git-push" -q --no-veri origin HEAD',
    'git-push --no-verify',
    'C:/Git/mingw64/libexec/git-core/git-push.exe --no-verify',
    'HOME=/tmp/h /usr/lib/git-core/git-push origin HEAD',
    'xargs /usr/lib/git-core/git-push --no-verify < /dev/null',
    "/usr/lib/git-core/git-config alias.p 'push --no-verify'",
    '$(git --exec-path)/git-config core.hooksPath /tmp/h',
    'git-config --global --edit',
  ]) assert.deepEqual([bash(c).decision, bash(c).rule], ['deny', 'push-hook-bypass'], c);
  for (const c of ['/usr/lib/git-core/git-push origin HEAD', 'git-config --get core.hooksPath']) assert.equal(bash(c).decision, 'none', c);
});

test("git's own commands are never an alias, so a line that sets git's environment or changes directory may run them (#993)", () => {
  const { dir } = exampleProject();
  execFileSync('git', ['config', 'alias.p', 'push --no-verify'], { cwd: dir, stdio: 'ignore' });
  const ctx = { ...exampleContext(cfg, dir, true), git: liveContext(dir).git! };
  const live = (command: string) => evaluate({ tool: 'Bash', input: { command }, cwd: dir }, cfg, ctx);
  for (const c of [
    'cd "$D" && git ls-files',
    'GIT_PAGER=cat git ls-files',
    'GIT_TRACE=1 git diff-index HEAD',
    'cd ~/x && git diff-tree HEAD',
    'cd "$(git rev-parse --show-toplevel)" && git ls-files',
    'cd "$D" && git mergetool --tool-help',
    'GIT_PAGER=cat git -C sub diff-files',
  ]) {
    assert.equal(live(c).decision, 'none', c);
    assert.equal(bash(c).decision, 'none', `${c} (examples)`);
  }
  // A git-<name> program on PATH: git runs it, never an alias of that name.
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  writeFileSync(join(bin, 'git-frob'), '#!/bin/sh\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
  try {
    assert.equal(live('GIT_PAGER=cat git frob ls-files').decision, 'none');
    // Where the line moves PATH or git's exec path, only what that can't move counts as git's own.
    for (const c of ['PATH=/tmp/x GIT_TRACE=1 git frob', 'env -u PATH GIT_TRACE=1 git frob', 'GIT_EXEC_PATH=/tmp/x git mergetool', 'cd "$D" && git --exec-path=/tmp/x mergetool']) {
      assert.equal(live(c).rule, 'push-hook-bypass', c);
    }
  } finally {
    process.env.PATH = path;
  }
  for (const c of ['GIT_TRACE=1 git frob', 'cd "$D" && git frob', 'cd "$D" && git p', 'GIT_PAGER=cat git p']) assert.equal(live(c).rule, 'push-hook-bypass', c);
});

test('text inside a quoted argument is not a command: a commit message may say env -i (#993)', () => {
  for (const c of ['git commit -m "fix env -i handling" && git push', "git commit -m 'env -u X' && git push origin HEAD"]) assert.equal(bash(c).decision, 'none', c);
  for (const c of ['env -i git push', 'git commit -m x && env -u HOME git push', 'bash -c "env -i git push"', 'find . -maxdepth 0 -exec env -i git push \\;']) assert.equal(bash(c).rule, 'push-hook-bypass', c);
});

test('git, env and the hookless push programs count only where a command runs them, not as any argument (#993)', () => {
  // A word that names git or env as an argument runs nothing.
  for (const c of [
    'cd "$D" && rm -rf vendor/git build',
    'cd "$D" && tar czf out.tgz src/git docs',
    'cd "$D" && sudo apt-get install -y git curl',
    'GIT_TRACE=1 make -C third_party/git all',
    'git grep env -- src && git push',
    'find . -name env -type d && git push',
    'rg env -i src && git push',
    'ls env -la && git push',
    'which env -a && git push',
    'echo env -i && git push',
  ]) assert.equal(bash(c).decision, 'none', c);
  // Where a wrapper or runner the guard models runs them, they are read.
  for (const c of [
    'nice -n 15 git push --no-verify',
    'ionice -c 3 git push --no-verify',
    'env -u X git push --no-verify',
    'env -iu X git push',
    'env --unset X git push --no-verify',
    'env -C /tmp git push --no-verify',
    'env --chdir sub git push --no-verify',
    "env -S 'git push --no-verify'",
    'exec -a x git push --no-verify',
    'setsid git push --no-verify',
    'flock /tmp/l git push --no-verify',
    'strace -f -o /tmp/t git push --no-verify',
    'setsid env -i git push',
    'find . -maxdepth 0 -exec /usr/lib/git-core/git-send-pack ../remote.git HEAD:refs/heads/sp \\;',
    'find . -maxdepth 0 -execdir git-http-push https://example.com/r.git HEAD \\;',
    'find . -maxdepth 0 -exec git-push --no-verify \\;',
    'find . -maxdepth 0 -exec true \\; -exec git push --no-verify \\;',
    'setsid /usr/lib/git-core/git-send-pack ../remote.git HEAD',
    'xargs -0 /usr/lib/git-core/git-send-pack ../remote.git < /dev/null',
  ]) assert.deepEqual([bash(c).decision, bash(c).rule], ['deny', 'push-hook-bypass'], c);
});

test("git's command list narrows only where the line removes or moves PATH or git's exec path (#993)", () => {
  const { dir } = exampleProject();
  const ctx = { ...exampleContext(cfg, dir, true), git: liveContext(dir).git! };
  const live = (command: string) => evaluate({ tool: 'Bash', input: { command }, cwd: dir }, cfg, ctx);
  const bin = mkdtempSync(join(tmpdir(), 'bin-'));
  writeFileSync(join(bin, 'git-frob'), '#!/bin/sh\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${path ?? ''}`;
  try {
    for (const c of [
      'unset GIT_DIR; git submodule update --init',
      'unset FOO; git mergetool --tool-help',
      'env -u GIT_INDEX_FILE git submodule status',
      'unset FOO; git frob ls-files',
      'export -n FOO; git frob pull',
      'env -u FOO git frob',
      'env -uFOO git frob',
    ]) assert.equal(live(c).decision, 'none', c);
    for (const c of [
      'unset PATH; git frob',
      'export -n PATH; git frob',
      'env -u PATH git frob',
      'env --unset=PATH git frob',
      'env -uPATH git frob',
      'unset GIT_EXEC_PATH; git mergetool',
      'env -u GIT_EXEC_PATH git mergetool',
      'env -i git mergetool',
      'env -iuFOO git mergetool',
      'env - git frob',
    ]) assert.equal(live(c).rule, 'push-hook-bypass', c);
  } finally {
    process.env.PATH = path;
  }
});

test("a runner's command is the first word after the runner's own options and operands, and nothing later (#993)", () => {
  for (const c of [
    'GIT_TRACE=1 strace -f make -C third_party/git all',
    'cd "$D" && flock /tmp/l rm -rf vendor/git build',
    'setsid make -C vendor/git all',
    'chronic rg env -i src && git push',
    'setsid ls env -la && git push',
    'cd "$D" && chronic apt-get install -y git curl',
    'GIT_TRACE=1 flock /tmp/l make -C third_party/git all',
    'flock /tmp/l grep -r env -i src && git push',
    'strace -f npm run env -- -i && git push',
    'taskset -c 0 make -C vendor/git all',
    'GIT_TRACE=1 someprogram --run git frob',
  ]) assert.equal(bash(c).decision, 'none', c);
  for (const c of [
    'flock /tmp/git git push --no-verify',
    'flock /tmp/find git push --no-verify',
    'flock -w 5 /tmp/l git push --no-verify',
    'flock -x /tmp/l -- git push --no-verify',
    'strace -o /tmp/git git push --no-verify',
    'strace -f -e trace=execve git push --no-verify',
    'taskset 0x1 git push --no-verify',
    'taskset -c 0 git push --no-verify',
    'chrt -f 10 git push --no-verify',
    'nsenter -t 1 -m git push --no-verify',
    'unshare -r git push --no-verify',
    'systemd-run --user --unit x git push --no-verify',
    'ssh-agent -t 60 git push --no-verify',
    'setsid -w env -i git push',
    'chronic -e flock /tmp/l git push --no-verify',
    'stdbuf -o 0 /usr/lib/git-core/git-send-pack ../remote.git HEAD',
    // Values of wrapper options, and find's -ok forms.
    'doas -u root git push --no-verify',
    'time -o /tmp/t git push --no-verify',
    "env --split-string='git push --no-verify'",
    'timeout --kill-after 5 60 git push --no-verify',
    'timeout --signal KILL 60 git push --no-verify',
    'xargs --max-args 1 git push --no-verify < /dev/null',
    'xargs --delimiter x git push --no-verify < /dev/null',
    'find . -maxdepth 0 -ok git push --no-verify \\;',
    'find . -maxdepth 0 -okdir git push --no-verify \\;',
  ]) assert.deepEqual([bash(c).decision, bash(c).rule], ['deny', 'push-hook-bypass'], c);
});

test("git config is read by git's own argument rules: options end at the first other word, and a second operand is a value (#993)", () => {
  // Measured with git 2.43 in a scratch repository: each refused line that names a value after the name writes it.
  const allow = 'none';
  const deny = 'deny';
  const table: [string, string][] = [
    // One name, after options that only choose a file, scope, type or output: a read.
    ['git config alias.st', allow],
    ['git config help.autocorrect', allow],
    ['git config --global alias.lg', allow],
    ['git config include.path', allow],
    ['git config core.hooksPath', allow],
    ['git config --file .gitmodules submodule.x.path', allow],
    ['git config --type bool help.autocorrect', allow],
    ['git config --local --show-origin core.hooksPath', allow],
    ['git config -- alias.st', allow],
    // A read action, or get/list in the subcommand place: a read, whatever follows.
    ['git config --get core.hooksPath x', allow],
    ['git config --get-all alias.p', allow],
    ['git config --fixed-value --get alias.st x', allow],
    ['git config --get-regexp alias', allow],
    ['git config --list', allow],
    ['git config get core.hooksPath', allow],
    ['git config --global get alias.p', allow],
    ['git config list --show-origin', allow],
    // A word after the name is a value, even one shaped like an option (git stops reading options at the name).
    ['git config core.hooksPath --global', deny],
    ['git config core.hooksPath --bool', deny],
    ['git config --local core.hooksPath --show-origin', deny],
    ['git config include.path --global', deny],
    ['git config includeIf.onbranch:main.path --global', deny],
    ['git config alias.p --global', deny],
    ['git config help.autocorrect --bool', deny],
    ['git config core.hooksPath --get', deny],
    ['git config core.hooksPath --', deny],
    ['git config -- core.hooksPath /tmp/h', deny],
    // get or list anywhere but the subcommand place is an operand: here a value-pattern.
    ['git config core.hooksPath /tmp/nohooks get', deny],
    ['git config --global core.hooksPath /tmp/nohooks get', deny],
    ["git config alias.p 'push --no-verify' list", deny],
    ['git config include.path /tmp/evil.cfg get', deny],
    // Write actions and subcommands, and options not known to only choose a file (--glo is git's --global: refused).
    ['git config alias.st status', deny],
    ['git config --add alias.st status', deny],
    ['git config --replace-all alias.st status', deny],
    ['git config --unset alias.st', deny],
    ['git config --unset-all include.path', deny],
    ['git config unset alias.st', deny],
    ['git config set help.autocorrect 1', deny],
    ['git config --file /tmp/cfg alias.p push', deny],
    ['git config --type bool help.autocorrect true', deny],
    ['git config --unknown-option alias.p', deny],
    ['git config --glo alias.p', deny],
    ['git config edit', deny],
    ['git config --global rename-section alias x', deny],
    // A write of a name that can't carry the hooks or run a command is not the guard's to refuse.
    ['git config pull.rebase false', allow],
    ['git config pull.rebase --global', allow],
  ];
  for (const [c, want] of table) {
    for (const line of [c, `${c} && git push origin HEAD`]) {
      const v = bash(line);
      assert.deepEqual([v.decision, v.decision === 'deny' ? v.rule : undefined], [want, want === 'deny' ? 'push-hook-bypass' : undefined], line);
    }
  }
});

test("git config's short options are read as git's parse-options reads them: -e anywhere in a cluster edits (#993)", () => {
  // Measured with git 2.43 in a scratch repository (`git config -h`: -f <file> and -t <type> take a value; -e, -l
  // and -z are flags). A flag letter continues the cluster; a value letter takes the rest of it or the next word.
  const allow = 'none';
  const deny = 'deny';
  const table: [string, string][] = [
    // Each opens $EDITOR on the config file.
    ['git config -ez', deny],
    ['git config -zez', deny],
    ['git config -ezz', deny],
    ['git config --global -ez', deny],
    ['git config --global -ezz', deny],
    ['git config -ef .git/config', deny],
    ['git config -ezf .git/config', deny],
    ['git config -ezf.git/config', deny],
    ['git config -zef .git/config', deny],
    ['git config -et bool', deny],
    ['git config -etbool', deny],
    ['git config -ze -t bool', deny],
    ['EDITOR=/tmp/ed.sh git config -ez', deny],
    ['git config -e', deny],
    ['git config -ze', deny],
    // Only one action at a time: git refuses, and so does the guard.
    ['git config -le', deny],
    ['git config -el', deny],
    // After a value letter, e is the value (a file named e, a type e): git edits nothing.
    ['git config -fe', allow],
    ['git config -te', allow],
    ['git config -tez', allow],
    // -t is --type: its value is not the name.
    ['git config -t bool --get help.autocorrect', allow],
    ['git config -tbool --get help.autocorrect', allow],
    ['git config -zt bool --get help.autocorrect', allow],
    ['git config -t bool help.autocorrect', allow],
    ['git config -lt bool', allow],
    ['git config -lf .git/config', allow],
    ['git config -f.git/config -l', allow],
    ['git config -lz', allow],
    ['git config -lz core.hooksPath /x', allow],
    // A letter git config doesn't list, like an unknown long option, is not known to only read.
    ['git config -x alias.p', deny],
    ['git config -t bool core.hooksPath true', deny],
    ['git config -tbool core.hooksPath true', deny],
    ["git config -zt bool alias.p 'push --no-verify'", deny],
    ['git config -f --get core.hooksPath /x', deny],
    ['git config -fz core.hooksPath /x', deny],
  ];
  for (const [c, want] of table) {
    for (const line of [c, `${c} && git push origin HEAD`]) {
      const v = bash(line);
      assert.deepEqual([v.decision, v.decision === 'deny' ? v.rule : undefined], [want, want === 'deny' ? 'push-hook-bypass' : undefined], line);
    }
  }
});

test("a runner's and env's options are read by their own option tables: values attached or next, and a leading -- (#993)", () => {
  for (const c of [
    // systemd-run -G is --collect, a flag (measured: systemd-run --help, getopt "+hrH:M:E:p:tPqGdSu:").
    'systemd-run --user -G make -C vendor/git all',
    'systemd-run --user --collect make -C vendor/git all',
  ]) assert.equal(bash(c).decision, 'none', c);
  for (const c of [
    'systemd-run --user -G git push --no-verify',
    // nsenter's -W takes an attached value only (measured: getopt "W::"; `nsenter -W /tmp echo` runs /tmp).
    'nsenter -W git push --no-verify',
    'systemd-run --user -s git push --no-verify',
    'systemd-run --user --path-property x git push --no-verify',
    // An attached value doesn't take the next word.
    'flock -w5 /tmp/l git push --no-verify',
    'strace -o/tmp/t git push --no-verify',
    'flock --timeout=5 /tmp/l git push --no-verify',
    'strace --output=/tmp/t git push --no-verify',
    // A leading -- ends the runner's options.
    'setsid -- git push --no-verify',
    'flock -- /tmp/l git push --no-verify',
    // Value options each program's own table lists (fakeroot's getopt; unshare's and ltrace's required values).
    'fakeroot -f /usr/bin/faked git push --no-verify',
    'fakeroot -b 3 git push --no-verify',
    'unshare --map-users 0:1000:1 git push --no-verify',
    'unshare --monotonic 5 git push --no-verify',
    'ltrace -D 1 git push --no-verify',
    'ltrace -L git push --no-verify',
    'strace --inject read:error=EIO git push --no-verify',
    // env's clusters as getopt reads them (measured: `env -uCC echo` and `env -iuX echo` run echo): the first value
    // letter takes the rest of the word, so the next word is the command.
    'env -uCC git push --no-verify',
    'env -uPROC git push --no-verify',
    'env -uSSH_AUTH_SOCK git push --no-verify',
    'env -iuX git push',
    "env -S'git push --no-verify'",
    "env -vS 'git push --no-verify'",
  ]) assert.deepEqual([bash(c).decision, bash(c).rule], ['deny', 'push-hook-bypass'], c);
});

test('a git name read from config: an alias or a correction to push is judged as the push it runs (#993)', () => {
  const { dir } = exampleProject();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('config', 'alias.p', 'push --no-verify');
  git('config', 'alias.pp', 'p');
  git('config', 'alias.r', 'push');
  git('config', 'alias.s', '-c core.hooksPath=/dev/null push');
  git('config', 'alias.sh', '!git push');
  git('config', 'alias.st', 'status -sb');
  const ctx = { ...exampleContext(cfg, dir, true), git: liveContext(dir).git! };
  const live = (command: string, cwd = dir) => evaluate({ tool: 'Bash', input: { command }, cwd }, cfg, ctx);
  for (const c of ['git p', 'git pp origin HEAD', 'git r --no-veri', 'git s', 'git sh', 'git -C . p', `cd ${dir} && git p`, 'HOME=/tmp/h git r', 'git st; HOME=/tmp/h git r']) {
    assert.deepEqual([live(c).decision, live(c).rule], ['deny', 'push-hook-bypass'], c);
  }
  assert.equal(live('git p', join(dir, 'missing')).rule, 'push-hook-bypass', 'a lookup that fails refuses');
  for (const c of ['git r', 'git r origin HEAD:refs/heads/task', 'git st', 'git lfs ls-files', 'git psuh --no-verify']) assert.equal(live(c).decision, 'none', c);
  // With help.autocorrect on, git runs the push a misspelt name is closest to.
  git('config', 'help.autocorrect', 'immediate');
  assert.equal(live('git psuh --no-verify').rule, 'push-hook-bypass');
  assert.equal(live('git psuh origin HEAD').decision, 'none', 'a corrected push through the hook');
});

test('the spellings are real: git skips the pre-push hook for each, and the guard refuses each (#993)', () => {
  const base = mkdtempSync(join(tmpdir(), 'skip-'));
  const run = (args: string[], cwd: string, env: Record<string, string> = {}) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', ...env } });
  run(['init', '-q', '--bare', 'remote.git'], base);
  const work = join(base, 'work');
  run(['init', '-q', 'work'], base);
  run(['-c', 'user.name=Ada', '-c', 'user.email=ada@example.com', 'commit', '-q', '--allow-empty', '-m', 'init'], work);
  run(['remote', 'add', 'origin', '../remote.git'], work);
  writeFileSync(join(work, '.git', 'hooks', 'pre-push'), '#!/bin/sh\necho HOOK-RAN >&2\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(base, 'cfg'), '[core]\n\thooksPath = /dev/null\n');
  const pushed = (args: string[]) => {
    const r = run(args, work);
    return r.status === 0 && !r.stderr.includes('HOOK-RAN');
  };
  assert.equal(pushed(['push', '-q', 'origin', 'HEAD:refs/heads/control']), false, 'the hook runs and refuses a plain push');
  const spellings: string[][] = [
    ['push', '-q', '--no-veri', 'origin', 'HEAD:refs/heads/a'],
    ['-c', `include.path=${join(base, 'cfg')}`, 'push', '-q', 'origin', 'HEAD:refs/heads/b'],
    ['-c', 'alias.p=-c core.hooksPath=/dev/null push', 'p', '-q', 'origin', 'HEAD:refs/heads/c'],
    ['-c', 'help.autocorrect=immediate', 'psuh', '-q', '--no-verify', 'origin', 'HEAD:refs/heads/d'],
    ['send-pack', '../remote.git', 'HEAD:refs/heads/e'],
  ];
  for (const args of spellings) {
    assert.equal(pushed(args), true, `git ${args.join(' ')} skips the hook`);
    const line = ['git', ...args.map((a) => (/\s/.test(a) ? `'${a}'` : a))].join(' ');
    assert.deepEqual([bash(line, true, work).decision, bash(line, true, work).rule], ['deny', 'push-hook-bypass'], line);
  }
  // git's own git-push program, run by path.
  const program = join(run(['--exec-path'], work).stdout.trim(), 'git-push');
  const dashed = spawnSync(program, ['-q', '--no-verify', 'origin', 'HEAD:refs/heads/f'], { cwd: work, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(dashed.status === 0 && !dashed.stderr.includes('HOOK-RAN'), true, `${program} --no-verify skips the hook`);
  assert.equal(bash(`${program} -q --no-verify origin HEAD:refs/heads/f`, true, work).rule, 'push-hook-bypass');
});

test('what stays frictionless for an agent: plain pushes and commits, reading about the hatch, its own tests and docs', () => {
  for (const c of [
    'git push',
    'git push origin HEAD:refs/heads/task',
    'git push -n origin HEAD',
    'git push -u origin HEAD',
    'git push --verbose --force-with-lease origin HEAD:refs/heads/task',
    'git push --verify origin HEAD',
    'git status && git push origin HEAD',
    'cd sub && git push',
    'git -C sub push origin HEAD',
    'git config --get alias.p',
    'git config --get-regexp alias',
    'git config --get help.autocorrect',
    'git log --grep=--no-verify',
    'git lfs ls-files',
    'echo git push --no-verify',
    'HOME=/tmp/h npm test',
    'git commit -q -m fix',
    'git commit --no-verify -m fix',
    'git config --get core.hooksPath',
    'git config --list',
    'git config get core.hooksPath',
    'git config pull.rebase false',
    'GIT_CONFIG_GLOBAL=/dev/null npm test',
    `grep -rn ${H} docs scripts`,
    `rg -n ${H}`,
    `grep -c ${H} CONTRIBUTING.md | head -1`,
    `cat CONTRIBUTING.md | grep ${H}`,
    `git grep -n ${H}`,
    `git log -S${H} --oneline`,
    `git commit -m "Docs: when ${H} applies"`,
    'node --test dist/test/push-gate-hook.test.js',
    'npm run check:push',
    'ls .git/hooks',
    'cat .git/hooks/pre-push',
    'cat .git/config',
    'echo hooks > notes/config',
  ]) assert.equal(bash(c).decision, 'none', c);
  // Source, tests and docs may say the name: only files a shell or push reads its environment from are closed.
  for (const f of ['/p/CONTRIBUTING.md', '/p/scripts/push-gate-hook.mjs', '/p/test/push-gate-hook.test.ts', '/p/docs/environment.md']) {
    assert.equal(verdict('Write', { file_path: f, content: `${H}=1 git push` }).decision, 'none', f);
  }
});

test("a person's own session keeps the hatch and its hooks: none of this applies outside an agent run", () => {
  for (const c of [`${H}=1 git push`, `export ${H}=1`, `echo 'export ${H}=1' >> ~/.zshrc`, 'git push --no-verify', 'git -c core.hooksPath=/dev/null push', 'git config core.hooksPath .githooks', 'rm .git/hooks/pre-push']) {
    assert.equal(bash(c, false).decision, 'none', c);
  }
  assert.equal(verdict('Write', { file_path: '/home/example/.zshrc', content: `export ${H}=1` }, false).decision, 'none');
  assert.equal(verdict('Write', { file_path: '/p/.git/hooks/pre-push', content: 'x' }, false).decision, 'none');
});

test('the hook path: an agent session is denied, the same call in a person\'s session is not', async () => {
  const { dir } = exampleProject();
  const input = { hook_event_name: 'PreToolUse', cwd: dir, tool_name: 'Bash', tool_input: { command: `${H}=1 git push origin HEAD` } };
  const env = { HOME: mkdtempSync(join(tmpdir(), 'home-')), [`${BRAND.envPrefix}_PROJECT_STATE_DIR`]: mkdtempSync(join(tmpdir(), 'state-')) };
  const agent = await runHook('pre-tool-use', input, { ...env, [`${BRAND.envPrefix}_AGENT`]: '1' });
  const out = JSON.parse(agent.stdout ?? '{}') as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', agent.stdout);
  assert.match(out.hookSpecificOutput?.permissionDecisionReason ?? '', /push-gate-hatch: PUSH_GATE_BOOTSTRAP is the push gate's first-time-setup hatch/);
  const swap = await runHook('pre-tool-use', { ...input, tool_input: { command: 'git -c core.hooksPath=/dev/null push' } }, { ...env, [`${BRAND.envPrefix}_AGENT`]: '1' });
  assert.match(swap.stdout ?? '', /"permissionDecision":"deny".*push-hook-bypass/);
  const person = await runHook('pre-tool-use', input, env);
  assert.deepEqual([person.exitCode, person.stdout], [0, undefined], 'no objection in a person\'s session');
});

test('no agent starts with the hatch: not from the coordinator\'s environment, a project\'s env, or a caller\'s extras', () => {
  const base = { PATH: '/usr/bin', HOME: '/home/example', [H]: '1' };
  assert.equal(H in agentEnv(base, 'cli'), false, 'not passed through');
  assert.equal(H in agentEnv(base, 'api_key', { [H]: '1', KEEP: 'x' }), false, 'not even when a caller hands it in');
  assert.equal(agentEnv(base, 'cli', { KEEP: 'x' }).KEEP, 'x');
  const lower = agentEnv(base, 'cli', { [H.toLowerCase()]: '1' });
  assert.deepEqual(Object.keys(lower).filter((k) => k.toUpperCase() === H), [], 'any spelling of its case (Windows)');
  const asUser = runAsEnv({ PATH: '/usr/bin', [H]: '1' }, { user: 'shop-agent', home: '/home/user' });
  assert.equal(H in asUser, false, 'nor as the agent user');
  assert.equal(asUser.HOME, '/home/user');
  // A project's committed env (tests.yaml) can't name it.
  assert.match(projectEnvProblem(H) ?? '', /harness or the system/);
  assert.equal(TestsConfig.safeParse({ version: 1, runner: { kind: 'command', changed: 'x', full: 'x' }, env: { [H]: '1' } }).success, false);
  assert.deepEqual(safeProjectEnv({ [H]: '1', WORKERS: '4' }), { WORKERS: '4' });
  assert.deepEqual(withoutPushGateHatch({ A: '1', [H]: '1' }), { A: '1' });
});

test('project commands the engine runs (checks, tests) do not inherit the hatch from the engine\'s own environment', () => {
  const before = process.env[H];
  process.env[H] = '1';
  try {
    assert.equal(H in childEnv(), false);
    assert.equal(H in childEnv({ [H]: '1' }), false);
    assert.equal(H in projectCommand('true').env, false);
    assert.equal(H in projectCommand('true', undefined, { [H]: '1', WORKERS: '4' }).env, false);
    assert.equal(process.env[H], '1', "the engine's own environment is left alone");
  } finally {
    if (before === undefined) delete process.env[H];
    else process.env[H] = before;
  }
});
