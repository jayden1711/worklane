export interface ProdReadConfig {
    via: 'railway-ssh';
    service: string;
    environment: string;
    url_var: string;
    max_rows: number;
    timeout_s: number;
}
/** Statements in a SQL string, ignoring semicolons inside quotes and comments. */
export declare function statementCount(sql: string): number;
/** The client that runs inside the service. Plain CommonJS; needs only `pg`. */
export declare function remoteClient(urlVar: string, maxRows: number, timeoutMs: number): string;
/** argv for the platform CLI. Script and SQL travel base64-encoded, so no shell quoting can be injected. */
export declare function prodReadArgv(cfg: ProdReadConfig, sql: string): string[];
export interface ProdReadResult {
    ok: boolean;
    output: string;
    error?: string;
}
export declare function prodRead(cfg: ProdReadConfig, sql: string, cwd: string): ProdReadResult;
