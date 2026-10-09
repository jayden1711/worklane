// Vacuous-test detection, for any Node test runner.
//  static:  a test file with no assertion calls (configured pattern) fails.
//  dynamic: run the file under NODE_V8_COVERAGE; it must execute at least one
//           function inside the app's paths. Merely importing a module runs
//           only its top level, which doesn't count.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegExp } from './guardrails/glob.js';
import { childEnv, shellCommand } from './os/index.js';
export function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}
export function countAssertions(src, pattern) {
    return [...stripComments(src).matchAll(new RegExp(pattern, 'g'))].length;
}
/** App files in which at least one non-top-level function ran. */
export function touchedAppFiles(coverageDir, root, appPaths) {
    const res = appPaths.map((g) => globToRegExp(g));
    const realRoot = realpathSync(root);
    const touched = new Set();
    for (const f of readdirSync(coverageDir)) {
        if (!f.endsWith('.json'))
            continue;
        const cov = JSON.parse(readFileSync(join(coverageDir, f), 'utf8'));
        for (const script of cov.result) {
            if (!script.url.startsWith('file:'))
                continue;
            let file;
            try {
                file = realpathSync(fileURLToPath(script.url));
            }
            catch {
                continue;
            }
            const rel = relative(realRoot, file).split('\\').join('/');
            if (rel.startsWith('..') || !res.some((re) => re.test(rel)))
                continue;
            if (script.functions.some((fn) => fn.functionName !== '' && (fn.ranges[0]?.count ?? 0) > 0))
                touched.add(rel);
        }
    }
    return [...touched].sort();
}
export function checkVacuity(root, file, opts) {
    const why = [];
    const assertions = countAssertions(readFileSync(join(root, file), 'utf8'), opts.assertionPattern);
    if (assertions === 0)
        why.push(`no assertion calls matching /${opts.assertionPattern}/`);
    const report = { file, assertions, vacuous: false, why };
    if (opts.dynamic) {
        if (!opts.runOne) {
            why.push('dynamic check needs tests.yaml runner.one');
        }
        else {
            const cov = mkdtempSync(join(tmpdir(), 'v8cov-'));
            try {
                const [shFile, shArgs] = shellCommand(opts.runOne.replaceAll('{file}', file));
                const r = spawnSync(shFile, shArgs, {
                    cwd: root,
                    encoding: 'utf8',
                    env: childEnv({ NODE_V8_COVERAGE: cov }),
                    timeout: 600_000,
                });
                report.ran = r.error ? { exitCode: r.status, error: r.error.message } : { exitCode: r.status };
                report.touched = touchedAppFiles(cov, root, opts.appPaths);
                if (r.error)
                    why.push(`could not run: ${r.error.message}`);
                else if (!report.touched.length)
                    why.push(`executed no function under ${opts.appPaths.join(', ')}`);
            }
            finally {
                rmSync(cov, { recursive: true, force: true });
            }
        }
    }
    report.vacuous = why.length > 0;
    return report;
}
//# sourceMappingURL=vacuity.js.map