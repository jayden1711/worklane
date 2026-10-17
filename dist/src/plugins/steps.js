// The machine helper's plugin and MCP steps, as the engine builds and checks them before recording a request (the
// dashboard) and again before running one (the coordinator). The same shapes as the helper's own checks
// (the helper script in scripts/machine/, parsePlugin) and its sudoers patterns (scripts/setup/lib.sh): an instance is never
// an argument, the helper takes the asking coordinator's from sudo; and no step confirms.
import { NPM_NAME, NPM_VERSION } from '../mcp/npm.js';
import { PLUGIN_ID } from './approval.js';
import { pluginUrlProblem, readPluginHosts } from './hosts.js';
const URL_OK = /^https:\/\/[A-Za-z0-9.-]+\/[A-Za-z0-9._~/-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const SUBDIR = /^(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ROLES = /^[a-z][a-z0-9-]{0,30}(?:\+[a-z][a-z0-9-]{0,30})*$/;
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOST = `(?:\\*\\.)?${LABEL}(?:\\.${LABEL})+`;
const HOSTS = new RegExp(`^(?:none|${HOST}(?:\\+${HOST})*)$`);
const SECRETS = /^(?:none|[A-Z][A-Z0-9_]{1,63}(?:\+[A-Z][A-Z0-9_]{1,63})*)$/;
const SERVER = /^[A-Za-z0-9_-]{1,40}$/;
export const PLUGIN_STEPS = ['plugin-fetch', 'plugin-stage', 'plugin-withdraw', 'plugin-remove', 'mcp-fetch', 'mcp-preview', 'mcp-snapshot', 'mcp-stage'];
/** Whether these are exactly one plugin step's arguments (the command first), in the helper's shapes. */
export function pluginStepOk(a) {
    const [cmd, id] = a;
    if (typeof id !== 'string' || !PLUGIN_ID.test(id))
        return false;
    switch (cmd) {
        case 'plugin-fetch':
            return (a.length === 4 || a.length === 5) && URL_OK.test(a[2]) && pluginUrlProblem(a[2], readPluginHosts().hosts) === null && SHA.test(a[3]) && (a.length === 4 || (SUBDIR.test(a[4]) && !a[4].split('/').some((p) => p === '.' || p === '..')));
        case 'plugin-stage':
            return a.length === 4 && DIGEST.test(a[2]) && ROLES.test(a[3]);
        case 'plugin-withdraw':
        case 'plugin-remove':
        case 'mcp-snapshot':
            return a.length === 2;
        case 'mcp-fetch':
            return a.length === 4 && NPM_NAME.test(a[2]) && NPM_VERSION.test(a[3]);
        case 'mcp-preview':
            return a.length === 4 && PLUGIN_ID.test(a[2]) && SERVER.test(a[3]);
        case 'mcp-stage':
            return a.length === 6 && DIGEST.test(a[2]) && ROLES.test(a[3]) && HOSTS.test(a[4]) && SECRETS.test(a[5]);
        default:
            return false;
    }
}
//# sourceMappingURL=steps.js.map