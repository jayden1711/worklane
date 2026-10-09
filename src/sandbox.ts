// Claude Code's native sandbox for agents, per lane. The sandbox covers
// shell commands (and their children): what they can read, and which hosts
// they can reach through its proxy. The file tools don't run inside it, so
// the same paths are also denied to the Read tool by permission rules. The
// stronger boundary is the OS one: agents run as their own user, and the
// coordinator's credentials are unreadable to that user anyway.

export interface Lane {
  /** Hosts sandboxed commands may reach (the sandbox's proxy checks each connection). */
  allowedDomains: string[];
}

export interface SandboxInput {
  lane: Lane;
  /** Paths no agent command may read: the coordinator's home, credential stores, other lanes' keys. */
  denyRead: string[];
}

/** Absolute paths, in the sandbox's and the Read rule's absolute forms. */
const abs = (p: string) => (p.startsWith('/') ? p : `/${p}`);

/**
 * Settings passed to each agent run with --settings. Fail closed: if the
 * sandbox can't start (a missing dependency, an unsupported platform), the
 * run exits instead of running unsandboxed, and a blocked command can't be
 * retried outside the sandbox.
 */
export function sandboxSettings(s: SandboxInput) {
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
export function homeCredentialStores(home: string): string[] {
  return ['.ssh', '.aws', '.config/gh', '.gnupg', '.netrc', '.npmrc', '.pypirc', '.docker/config.json'].map((p) => `${home.replace(/\/$/, '')}/${p}`);
}
