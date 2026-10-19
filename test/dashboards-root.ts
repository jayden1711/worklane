// dashboards.sh in a temporary root, for the #742 tests: its lib.sh sources the real one, then points the machine's
// paths into the root and stands in for what needs root (users, ACLs, systemd, sudo). One instance, alpha, is ready
// for it. Nothing here runs a real sudo, setfacl or systemctl.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './helpers.js';

const setupDir = join(repoRoot, 'scripts', 'setup');

export function machine() {
  const T = mkdtempSync(join(tmpdir(), 'dash-root-'));
  const s = join(T, 'scripts', 'setup');
  for (const d of ['scripts/setup', 'bin', 'units', 'libexec', 'sudoers.d', 'cmd-bin']) mkdirSync(join(T, d), { recursive: true });
  copyFileSync(join(setupDir, 'dashboards.sh'), join(s, 'dashboards.sh'));
  writeFileSync(
    join(s, 'lib.sh'),
    `source ${JSON.stringify(join(setupDir, 'lib.sh'))}
T=${JSON.stringify(T)}
PATH="$T/bin:$PATH"
as_root() { :; }
home_of() { echo "$T/home/$1"; }
ensure_user() { echo "user $1 exists"; }
refuse_if_open() { :; }
HUB_UNIT="$T/units/worklane-dashboard-hub.service" ENGINE_CLI="$T/bin/engine-cli" MACHINE_OWNERS="$T/machine-owners.json"
CONSOLE_SHELL="$T/libexec/worklane-console-shell" CONSOLE_SUDOERS="$T/sudoers.d/worklane-console"
`,
  );
  const calls = join(T, 'calls');
  const exe = (dir: string, name: string, body: string) => {
    writeFileSync(join(T, dir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(T, dir, name), 0o755);
  };
  for (const c of ['systemctl', 'systemd-analyze', 'setfacl', 'engine-cli']) exe('bin', c, `echo "${c} $*" >> ${JSON.stringify(calls)}`);
  exe('bin', 'id', 'echo 1000');
  // The viewer may read each dashboard token, and a gateway token only while the last ACL change to it (in the calls
  // log) granted it, as the real ACLs give it; nothing else.
  exe(
    'bin',
    'sudo',
    [
      '[ "$1" = -u ] && shift 2',
      '[ "$1 $2" = "test -r" ] || exit 1',
      'case "$3" in',
      '  */dashboard-token) exit 0 ;;',
      '  *-gateway-token)',
      '    last=""',
      `    while IFS= read -r l; do [ "$l" = "setfacl -m g:wl-dash:r-- $3" ] && last=m; [ "$l" = "setfacl -x g:wl-dash $3" ] && last=x; done < ${JSON.stringify(calls)}`,
      '    [ "$last" = m ] ;;',
      '  *) exit 1 ;;',
      'esac',
    ].join('\n'),
  );
  // The pasted command's own sudo: runs dashboards.sh from this root in place of the installed engine's.
  exe('cmd-bin', 'sudo', `[ "$1" = bash ] && [[ "$2" == /opt/*/current/scripts/setup/dashboards.sh ]] || { echo "not the rerun: $*" >&2; exit 99; }\nshift 2\nexec bash ${JSON.stringify(join(s, 'dashboards.sh'))} "$@"`);
  const state = join(T, 'home', 'wl-alpha', '.local', 'state', 'worklane', 'instances', 'alpha', 'state');
  mkdirSync(state, { recursive: true });
  for (const f of ['dashboard-token', 'siri-gateway-token', 'hooks-gateway-token']) writeFileSync(join(state, f), 'x');
  const signin = join(T, 'home', 'wl-dash', '.config', 'dashboard-signin');
  const hubState = join(T, 'home', 'wl-dash', '.local', 'state', 'worklane', 'dashboard-hub');
  for (const d of [signin, hubState]) mkdirSync(d, { recursive: true });
  for (const f of ['client-secret', 'session-secret']) writeFileSync(join(signin, f), 'x');
  writeFileSync(join(hubState, 'dashboard-token'), 'x');
  const paths = { unit: join(T, 'units', 'worklane-dashboard-hub.service'), shell: join(T, 'libexec', 'worklane-console-shell'), sudoers: join(T, 'sudoers.d', 'worklane-console'), calls, state };
  // dashboards.sh's mktemp -d goes under the root too, not the machine's /tmp.
  const tmp = join(T, 'tmp');
  mkdirSync(tmp);
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: T, TMPDIR: tmp };
  const run = (args: string[]) => spawnSync('bash', [join(s, 'dashboards.sh'), ...args], { encoding: 'utf8', env, timeout: 60_000 });
  /** A command line as the owner pastes it into a root shell: `sudo bash /opt/<cli>/current/...` runs this root's dashboards.sh. */
  const paste = (command: string) => spawnSync('bash', ['-c', command], { encoding: 'utf8', cwd: T, env: { ...env, PATH: `${join(T, 'cmd-bin')}:${env.PATH}` }, timeout: 60_000 });
  /** What lib.sh's hub_keep_args (add-project, instance-remove, instance-rename) forwards from the unit now. */
  const kept = () => spawnSync('bash', ['-c', 'source "$1"; HUB_UNIT="$2"; hub_keep_args', '_', join(setupDir, 'lib.sh'), paths.unit], { encoding: 'utf8' }).stdout.trim().split('\n');
  return { T, paths, run, paste, kept };
}
