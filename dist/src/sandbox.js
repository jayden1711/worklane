// Claude Code's native sandbox for agents, per lane. The sandbox covers
// shell commands (and their children): what they can read, and which hosts
// they can reach through its proxy. The file tools don't run inside it, so
// the same paths are also denied to the Read tool by permission rules. The
// stronger boundary is the OS one: agents run as their own user, and the
// coordinator's credentials are unreadable to that user anyway.
/** Absolute paths, in the sandbox's and the Read rule's absolute forms. */
const abs = (p) => (p.startsWith('/') ? p : `/${p}`);
/**
 * Settings passed to each agent run with --settings. Fail closed: if the
 * sandbox can't start (a missing dependency, an unsupported platform), the
 * run exits instead of running unsandboxed, and a blocked command can't be
 * retried outside the sandbox.
 */
export function sandboxSettings(s) {
    const deny = [...new Set(s.denyRead.map(abs))];
    return {
        sandbox: {
            enabled: true,
            failIfUnavailable: true,
            allowUnsandboxedCommands: false,
            autoAllowBashIfSandboxed: true,
            network: { allowedDomains: [...new Set(s.lane.allowedDomains)] },
            filesystem: { denyRead: deny },
        },
        permissions: {
            // The Read tool runs outside the sandbox: deny it the same paths.
            deny: deny.map((p) => `Read(/${p}/**)`),
        },
    };
}
/** Credential stores in an agent user's home that its commands never need. */
export function homeCredentialStores(home) {
    return ['.ssh', '.aws', '.config/gh', '.gnupg', '.netrc', '.npmrc', '.pypirc', '.docker/config.json'].map((p) => `${home.replace(/\/$/, '')}/${p}`);
}
/** The hosts a run's settings let its commands reach (none when there are no settings). */
export function allowedDomainsOf(settings) {
    return (settings?.sandbox?.network?.allowedDomains ?? []).slice();
}
/** A copy of a run's settings whose commands may also reach `hosts` (for one run; the lane is unchanged). */
export function withAllowedDomains(settings, hosts) {
    const s = settings;
    return { ...s, sandbox: { ...s.sandbox, network: { ...s.sandbox?.network, allowedDomains: [...new Set([...allowedDomainsOf(s), ...hosts])] } } };
}
//# sourceMappingURL=sandbox.js.map