// The machine's own locations: everything the engine reads or runs outside a checkout and a user's home, in one place.
// /etc/<cli> (machine owners, network, updates, slots, limits, the watchdog, signers), /var/lib/<cli> (the machine's
// state: changes, updates log, the Claude account, the init lock, the agent slots), /usr/local/libexec/<cli>-* (the
// root helpers), /opt/<cli> (the installed engine), /run/lock (the full-run lock), and the systemd unit directory.
//
// WHY: the release runs `npm test` on a machine that runs the engine (#312). A test that read the real
// /etc/<cli>/machine-owners.json, the real helper, or the real updates log got the machine's answer, not the test's.
// test/isolate.ts sets <PREFIX>_SYSTEM_ROOT to a fresh temporary directory, so under the suite every one of these is
// inside it; test/isolate.test.ts checks every constant built here and that src/ names none of these roots elsewhere.
//
// INVARIANT: every such path in src/ is built by systemPath(); unset (every real machine), each is the path itself.
// Moving the root can only point the engine at files somewhere else: it never widens what root's helpers allow
// (sudo runs only the real helper paths its rules name, with its own environment).
//
// THREAT: whoever can set a coordinator's or the hub's environment (a drop-in unit, a sudo that keeps the
// environment) must not be able to use the variable to swap in another machine owners file, network.json or CA.
// So it is honoured only in a process the test preload marked (systemRootRefusal): never as root, never in a process
// systemd started, and only with the preload's per-run token, which must match the mark file inside the root, a
// directory and file of this user's alone. Everywhere else the engine refuses to run (src/os/system-root-guard.ts:
// a non-zero exit naming the variable, before anything starts), and systemPath() throws, so no import can read a
// moved path either. The service modes refuse it even in a marked process (serviceModeRefusal).
import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { BRAND } from '../brand.js';
/** The variable that moves every system location under one directory (tests only; test/isolate.ts). */
export const SYSTEM_ROOT_VAR = `${BRAND.envPrefix}_SYSTEM_ROOT`;
/** The test preload's per-run token: 64 hex characters, also written to TEST_MARK_FILE inside the root. */
export const TEST_TOKEN_VAR = `${BRAND.envPrefix}_TEST_ISOLATION`;
export const TEST_MARK_FILE = '.test-isolation';
/** Set by systemd in every process a unit starts (and inherited by its children). */
export const SYSTEMD_MARKERS = ['INVOCATION_ID', 'JOURNAL_STREAM'];
export class SystemRootRefused extends Error {
    name = 'SystemRootRefused';
}
const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);
/**
 * Why <PREFIX>_SYSTEM_ROOT may not be honoured in this process, or null when it may (unset, or a test process the
 * preload marked). INVARIANT: an allowlist: only the preload's mark makes it honoured; root and systemd never.
 */
export function systemRootRefusal(env = process.env, uid = currentUid()) {
    const root = env[SYSTEM_ROOT_VAR];
    if (!root)
        return null;
    const no = (why) => `${SYSTEM_ROOT_VAR} is set (${root}), and ${why}. It is honoured only in a test process the test preload marked (test/isolate.ts): unset it.`;
    if (uid === 0)
        return no('this process runs as root');
    const sd = SYSTEMD_MARKERS.find((k) => env[k] !== undefined);
    if (sd)
        return no(`systemd started this process (${sd} is set)`);
    const token = env[TEST_TOKEN_VAR];
    if (!token || !/^[0-9a-f]{64}$/.test(token))
        return no(`${TEST_TOKEN_VAR} doesn't carry the test preload's token`);
    if (!isAbsolute(root))
        return no('it is not an absolute path');
    const posix = process.platform !== 'win32';
    try {
        const d = lstatSync(root);
        if (!d.isDirectory() || (posix && ((uid !== null && d.uid !== uid) || (d.mode & 0o022) !== 0)))
            return no("its directory isn't this user's alone");
        const mark = join(root, TEST_MARK_FILE);
        const f = lstatSync(mark);
        if (!f.isFile() || (posix && ((uid !== null && f.uid !== uid) || (f.mode & 0o077) !== 0)))
            return no("its test mark isn't this user's alone");
        if (readFileSync(mark, 'utf8').trim() !== token)
            return no(`${TEST_TOKEN_VAR} doesn't match its test mark`);
    }
    catch {
        return no('it holds no test mark');
    }
    return null;
}
let decided = null;
/** `p` (an absolute system path) on this machine: itself, or under <PREFIX>_SYSTEM_ROOT when that is honoured here. */
export function systemPath(p) {
    if (!p.startsWith('/'))
        throw new Error(`systemPath: ${p} is not absolute`);
    const root = process.env[SYSTEM_ROOT_VAR];
    if (!root)
        return p;
    const key = [root, process.env[TEST_TOKEN_VAR], ...SYSTEMD_MARKERS.map((k) => process.env[k])].join('\0');
    if (decided?.key !== key)
        decided = { key, refusal: systemRootRefusal() };
    if (decided.refusal)
        throw new SystemRootRefused(decided.refusal);
    return join(root, p);
}
/**
 * Why this command line may not run with <PREFIX>_SYSTEM_ROOT set at all, marked or not: the long-lived modes the
 * machine's units run (scripts/setup/service.sh, dashboards.sh, and `up`'s user units): `coordinator run` (one pass,
 * --once, is a command that ends, which tests run), an instance's dashboard (--instance … --service), the hub (--hub)
 * and its setup mode (--hub-setup). Null for any
 * other command. A checkout's dashboard (`dashboard --service --root <dir>`, which `dashboard --detach` starts in the
 * person's own session) is none: every unit's dashboard is an instance's (--instance) or the hub's.
 */
export function serviceModeRefusal(argv, env = process.env) {
    if (!env[SYSTEM_ROOT_VAR])
        return null;
    const args = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--root' || argv[i] === '--instance')
            i++;
        else
            args.push(argv[i]);
    }
    const [cmd, sub] = args;
    const mode = cmd === 'coordinator' && sub === 'run' && !args.includes('--once') ? 'coordinator run' : cmd === 'dashboard' ? (['--hub', '--hub-setup'].find((f) => args.includes(f)) ?? (args.includes('--service') && argv.includes('--instance') ? '--instance --service' : undefined)) : undefined;
    return mode ? `${SYSTEM_ROOT_VAR} is set, and \`${cmd === 'dashboard' ? `dashboard ${mode}` : mode}\` is a service mode, which never runs with it: unset it.` : null;
}
/** The roots below, as the real machine has them (the lint in test/isolate.test.ts looks for these in src/). */
export const SYSTEM_ROOTS = {
    etc: `/etc/${BRAND.cli}`,
    varLib: `/var/lib/${BRAND.cli}`,
    libexec: '/usr/local/libexec',
    opt: `/opt/${BRAND.cli}`,
    runLock: '/run/lock',
    units: '/etc/systemd/system',
    varTmp: '/var/tmp',
};
/** /etc/<cli>/<name> */
export const etcPath = (name) => systemPath(`${SYSTEM_ROOTS.etc}/${name}`);
/** /var/lib/<cli>/<name> */
export const varLibPath = (name) => systemPath(`${SYSTEM_ROOTS.varLib}/${name}`);
/** /usr/local/libexec/<cli>-<name>: a root helper. */
export const libexecPath = (name) => systemPath(`${SYSTEM_ROOTS.libexec}/${BRAND.cli}-${name}`);
/** /opt/<cli>/<name>: the installed engine. */
export const optPath = (name) => systemPath(`${SYSTEM_ROOTS.opt}/${name}`);
/** /run/lock/<cli>-<name> */
export const runLockPath = (name) => systemPath(`${SYSTEM_ROOTS.runLock}/${BRAND.cli}-${name}`);
/** /etc/systemd/system/<unit> */
export const unitPath = (unit) => systemPath(`${SYSTEM_ROOTS.units}/${unit}`);
/** The test-run sandbox's base (scripts/setup/testrun-sandbox.sh): beside /var/lib/<cli>, its own directory. */
export const testRunBasePath = () => systemPath(`/var/lib/${BRAND.cli}-test`);
/** Single-user and development machines' slot directory (unbranded: every agent harness on the box shares it). */
export const devSlotsPath = () => systemPath(`${SYSTEM_ROOTS.varTmp}/agent-slots`);
/**
 * The same locations as root sees them, never moved: only for text that tells a person what to run as root, or what
 * root's helper changes (a root shell and the helper are outside the engine, so they always mean the real files). The
 * engine never opens or runs one of these; what it opens or runs is built by the functions above.
 */
export const asRoot = {
    etc: (name) => `${SYSTEM_ROOTS.etc}/${name}`,
    varLib: (name) => `${SYSTEM_ROOTS.varLib}/${name}`,
    libexec: (name) => `${SYSTEM_ROOTS.libexec}/${BRAND.cli}-${name}`,
    opt: (name) => `${SYSTEM_ROOTS.opt}/${name}`,
};
//# sourceMappingURL=system-paths.js.map