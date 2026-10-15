// The sandbox helper's protocol: the engine and the root-owned helper (scripts/machine/<cli>-testrun.sh) change
// together, but the helper is installed by root and an engine update alone doesn't replace it. So the engine asks
// the helper its protocol version (`<helper> <name> version`) once, at coordinator start, before any test run, and
// starts none unless it is exactly HELPER_PROTOCOL. A helper too old to have `version` (it dies with "unknown
// command") is outdated too. Outdated: no run starts, each PR gets a check that says so and how to fix it, and the
// watchdog raises one helper_outdated incident (from the testrun.helper event this records).
import { BRAND } from '../brand.js';
import { asRoot } from '../os/system-paths.js';
/** The protocol this engine speaks: the helper's PROTOCOL must equal it (a test checks the script's). */
export const HELPER_PROTOCOL = 7;
/** The one reinstall that fixes an outdated helper: only the helper, from the installed engine, nothing else changed. */
export const helperFix = (instance) => `sudo bash ${asRoot.opt('current/scripts/setup/test-user.sh')} update-helper, then restart the instance: sudo systemctl restart ${BRAND.cli}-${instance}.service`;
/** Ask the host's helper its protocol version, and compare it with this engine's. Never throws. */
export async function checkHelper(host, instance) {
    const need = HELPER_PROTOCOL;
    let have = null;
    let stderr = '';
    try {
        const v = await host.helperVersion();
        have = v.version;
        stderr = v.stderr;
    }
    catch (e) {
        stderr = e.message;
    }
    if (have === need)
        return { ok: true, have, need, detail: '', stderr: '' };
    const why = have !== null
        ? `the test sandbox helper speaks protocol ${have}, this engine needs ${need}`
        : /unknown command/.test(stderr)
            ? `the test sandbox helper is older than this engine (it has no version command; this engine needs protocol ${need})`
            : `the test sandbox helper couldn't be asked its version (this engine needs protocol ${need}): ${stderr.trim().split('\n').pop() ?? ''}`;
    return { ok: false, have, need, detail: `${why}. No test run starts until it is reinstalled: ${helperFix(instance)}`, stderr };
}
//# sourceMappingURL=helper.js.map