import type { SandboxManager as SandboxManagerType, SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime';
import { z } from 'zod';
/** What the broker writes for one server's sandbox. Paths absolute. */
export declare const SandboxedConfig: z.ZodObject<{
    allowedDomains: z.ZodArray<z.ZodString>;
    denyRead: z.ZodArray<z.ZodString>;
    allowWrite: z.ZodArray<z.ZodString>;
    cwd: z.ZodString;
}, z.core.$strict>;
export type SandboxedConfig = z.infer<typeof SandboxedConfig>;
/** One word for sh: single-quoted, any ' closed, escaped and reopened. */
export declare const shQuote: (s: string) => string;
/**
 * The whole configuration handed to sandbox-runtime: an allowlist and filesystem rules, nothing else. In particular no
 * `network.tlsTerminate` (the only path that builds the library's MITM CA with node-forge) and no `network.mitmProxy`:
 * the broker never terminates or intercepts a server's TLS. Pinned by test/mcp-sandboxed.test.ts.
 */
export declare function sandboxRuntimeConfig(cfg: SandboxedConfig): SandboxRuntimeConfig;
/** The part of sandbox-runtime's SandboxManager the broker uses; a seam so tests can see what reaches it. */
export type SandboxManagerLike = Pick<typeof SandboxManagerType, 'initialize' | 'wrapWithSandbox' | 'reset'>;
export declare function runSandboxed(configFile: string, argv: string[], manager?: SandboxManagerLike): Promise<number>;
