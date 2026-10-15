// The CLI's first import (src/cli.ts): with <PREFIX>_SYSTEM_ROOT set where it isn't honoured (src/os/system-paths.ts:
// as root, under systemd, without the test preload's mark, or in a service mode), the engine stops here, before any
// other module loads: a non-zero exit and one line naming the variable. Nothing has started, read or written.
import { BRAND } from '../brand.js';
import { serviceModeRefusal, systemRootRefusal } from './system-paths.js';
/** The exit code for a refused <PREFIX>_SYSTEM_ROOT (EX_CONFIG). */
export const SYSTEM_ROOT_REFUSED_EXIT = 78;
const refusal = systemRootRefusal() ?? serviceModeRefusal(process.argv.slice(2));
if (refusal) {
    process.stderr.write(`${BRAND.cli}: refused: ${refusal}\n`);
    process.exit(SYSTEM_ROOT_REFUSED_EXIT);
}
//# sourceMappingURL=system-root-guard.js.map