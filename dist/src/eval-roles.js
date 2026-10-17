// The role-prompt eval (scripts/eval-roles.mjs): its options, the run.cost record of every model call, and its
// verdict. Each role is scored on its visible cases and on its held-out cases (src/held-out.ts), 3 samples per
// case unless fewer are asked for (and the report says so). The held-out score decides: a role whose held-out
// score drops, is incomplete or is missing fails the run, whatever its visible score did.
import { comparisonDiff, comparisonLine, comparisonPasses, DEFAULT_SAMPLES } from './skilleval.js';
export function evalRolesOptions(argv) {
    const arg = (name, fallback) => {
        const i = argv.indexOf(`--${name}`);
        return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
    };
    const samples = Number(arg('samples', String(DEFAULT_SAMPLES)));
    if (!Number.isInteger(samples) || samples < 1)
        throw new Error(`--samples must be a whole number of at least 1, not ${arg('samples', '')}`);
    const cap = Number(arg('cap', '10'));
    if (!(cap > 0))
        throw new Error('--cap must be a positive number of dollars');
    const roles = arg('roles', '');
    return { base: arg('base', 'origin/main'), roles: roles ? roles.split(',') : [], model: arg('model', 'sonnet'), judge: arg('judge', 'opus'), samples, cap, writeHeldOut: argv.includes('--write-held-out'), scoreOnly: argv.includes('--score') };
}
/** An Ask whose every call is recorded as run.cost (role, model, the CLI's estimate). */
export function recordingAsk(ask, role, record) {
    return async (req) => {
        const r = await ask(req);
        record({ role, model: req.model, usd: r.costUsd, turns: 1 });
        return r;
    };
}
/** The report for one role (its line, then each case that changed), and whether the run fails for it. */
export function roleReport(c) {
    return { lines: [comparisonLine(c), ...comparisonDiff(c).map((d) => `  ${d}`)], fails: !comparisonPasses(c) };
}
//# sourceMappingURL=eval-roles.js.map