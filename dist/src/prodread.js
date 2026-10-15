// The one sanctioned production read path. It runs a fixed client INSIDE a
// production service (where the database's private host resolves), using
// only a read-only role's connection string that the owner stored on that
// service. Read-only is enforced by the database role; the client adds a
// READ ONLY transaction and refuses multi-statement SQL as defense in depth.
// No production credential ever reaches the agent's machine.
import { spawnSync } from 'node:child_process';
import { BRAND } from './brand.js';
import { shimsNeedShell } from './os/index.js';
/** Statements in a SQL string, ignoring semicolons inside quotes and comments. */
export function statementCount(sql) {
    let n = 0;
    let current = '';
    for (let i = 0; i < sql.length; i++) {
        const c = sql[i];
        if (c === "'" || c === '"') {
            const end = sql.indexOf(c, i + 1);
            current += sql.slice(i, end < 0 ? sql.length : end + 1);
            i = end < 0 ? sql.length : end;
        }
        else if (c === '-' && sql[i + 1] === '-') {
            const nl = sql.indexOf('\n', i);
            i = nl < 0 ? sql.length : nl;
        }
        else if (c === '/' && sql[i + 1] === '*') {
            const end = sql.indexOf('*/', i + 2);
            i = end < 0 ? sql.length : end + 1;
        }
        else if (c === ';') {
            if (current.trim())
                n++;
            current = '';
        }
        else
            current += c;
    }
    if (current.trim())
        n++;
    return n;
}
/** The client that runs inside the service. Plain CommonJS; needs only `pg`. */
export function remoteClient(urlVar, maxRows, timeoutMs) {
    return `
const { Client } = require('pg');
const sql = Buffer.from(process.argv[1] || '', 'base64').toString('utf8');
const url = process.env[${JSON.stringify(urlVar)}];
if (!url) { console.error('prod-read: ${urlVar} is not set on this service; the read-only role has not been installed'); process.exit(3); }
(async () => {
  const c = new Client({ connectionString: url, statement_timeout: ${timeoutMs}, query_timeout: ${timeoutMs + 2000} });
  await c.connect();
  try {
    await c.query('BEGIN TRANSACTION READ ONLY');
    const r = await c.query(sql);
    await c.query('ROLLBACK');
    const rows = (r.rows || []).slice(0, ${maxRows});
    console.log(JSON.stringify({ rowCount: r.rowCount, truncated: (r.rows || []).length > ${maxRows}, fields: (r.fields || []).map((f) => f.name), rows }));
  } finally { await c.end(); }
})().catch((e) => { console.error('prod-read: ' + e.message); process.exit(1); });
`.trim();
}
/** argv for the platform CLI. Script and SQL travel base64-encoded, so no shell quoting can be injected. */
export function prodReadArgv(cfg, sql) {
    const script = Buffer.from(remoteClient(cfg.url_var, cfg.max_rows, cfg.timeout_s * 1000)).toString('base64');
    const query = Buffer.from(sql).toString('base64');
    const remote = `node -e 'eval(Buffer.from("${script}","base64").toString())' ${query}`;
    return ['ssh', '--service', cfg.service, '--environment', cfg.environment, '--', 'sh', '-c', remote];
}
export function prodRead(cfg, sql, cwd) {
    const trimmed = sql.trim();
    if (!trimmed)
        return { ok: false, output: '', error: 'empty SQL' };
    if (statementCount(trimmed) !== 1)
        return { ok: false, output: '', error: 'exactly one SQL statement per read' };
    const r = spawnSync('railway', prodReadArgv(cfg, trimmed), {
        cwd,
        encoding: 'utf8',
        timeout: (cfg.timeout_s + 60) * 1000,
        shell: shimsNeedShell,
        env: { ...process.env, [`${BRAND.envPrefix}_PROD_READ`]: '1' },
    });
    const out = (r.stdout ?? '').split('\n').filter((l) => l.trim().startsWith('{')).pop() ?? '';
    if (r.error)
        return { ok: false, output: '', error: r.error.message };
    if (r.status !== 0 || !out)
        return { ok: false, output: '', error: (r.stderr || r.stdout || '').trim().split('\n').filter((l) => !/^Using SSH key/.test(l)).pop() ?? `exit ${r.status}` };
    return { ok: true, output: out };
}
//# sourceMappingURL=prodread.js.map