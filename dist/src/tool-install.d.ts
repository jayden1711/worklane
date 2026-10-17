export declare const PINS: {
    readonly gitleaks: {
        readonly version: "8.30.1";
        readonly sha256: {
            'linux-x64': string;
            'linux-arm64': string;
            'darwin-x64': string;
            'darwin-arm64': string;
        };
    };
    readonly gh: {
        readonly version: "2.101.0";
        readonly sha256: {
            'linux-x64': string;
            'linux-arm64': string;
            'darwin-x64': string;
            'darwin-arm64': string;
        };
    };
    readonly claude: {
        readonly version: "2.1.296";
        readonly integrity: "sha512-OX/k/rpcthMqnFKOWcpNcbiLsMKtAjLOpQNJHlYiDCFUznWCIwdRTyl/p9SdHVrsrzZuPMCNqZjnpakIni6upw==";
    };
};
export type InstallableTool = keyof typeof PINS;
export declare const INSTALLABLE: InstallableTool[];
/** One install, as shown to the person before it runs. */
export interface ToolInstall {
    tool: InstallableTool;
    version: string;
    url: string;
    /** sha256 (hex) of the download, or an npm integrity (sha512, base64). */
    checksum: {
        algo: 'sha256' | 'sha512';
        value: string;
    };
    archive: 'tar.gz' | 'zip' | 'npm';
    /** The binary's path inside the archive. */
    member: string;
    /** Where the binary ends up: <prefix>/bin/<tool>. */
    dest: string;
    prefix: string;
}
/** The install for a tool on this machine, or null where none is pinned (native Windows, another architecture). */
export declare function installPlan(tool: InstallableTool, prefix: string, plat?: {
    os: "linux" | "darwin";
    arch: "x64" | "arm64";
} | null): ToolInstall | null;
/** The plan in one line, as init prints it before asking. */
export declare function describeInstall(p: ToolInstall): string;
/** The download's checksum in the plan's form: sha256 hex, sha512 base64. */
export declare function checksumOf(file: string, algo: 'sha256' | 'sha512'): string;
export type Download = (url: string, file: string) => Promise<void>;
/** Fetch a URL to a file (redirects followed; GitHub's release downloads redirect). */
export declare const httpDownload: Download;
type Run = (cmd: string, args: string[]) => {
    status: number | null;
    stderr: string;
};
/**
 * Download, check, unpack and install one tool. The checksum is checked before anything is unpacked or run; a
 * mismatch deletes the download and installs nothing.
 */
export declare function installTool(p: ToolInstall, o?: {
    download?: Download;
    run?: Run;
}): Promise<{
    ok: true;
} | {
    ok: false;
    error: string;
}>;
export {};
