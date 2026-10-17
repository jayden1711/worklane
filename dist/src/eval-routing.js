import { ROUTING, route } from './routing.js';
export const DEFAULT_EVAL_ROUTING = { cheap_model: ROUTING.eval_cheap.default, cheap_levels: ROUTING.eval_cheap_levels.default, escalate: ROUTING.eval_escalate.default };
export function evalRouting(agents) {
    return { cheap_model: route(agents, 'eval_cheap').value, cheap_levels: route(agents, 'eval_cheap_levels').value, escalate: route(agents, 'eval_escalate').value };
}
/**
 * The level used to route the evaluation: the computed review level, except that a comment-only change routes
 * as L0 (it can't change behavior). Only routing; the change's review level for merging is untouched.
 */
export function routingLevel(level, files) {
    return commentOnly(files) ? 'L0' : level;
}
/** The model that judges a change at `level`: the cheap model for its levels, else the evaluator role's model. */
export function evaluatorModel(level, strongModel, r = DEFAULT_EVAL_ROUTING) {
    return r.cheap_levels.includes(level) ? r.cheap_model : strongModel;
}
/**
 * Whether a verdict goes to the stronger model before it counts: only a verdict from the cheap model (never one
 * the stronger model gave), and only when it isn't a confident pass: a rejection, an uncertain approval, or no
 * verdict at all. One escalation; the stronger model's verdict is final.
 */
export function shouldEscalate(o) {
    const r = o.routing ?? DEFAULT_EVAL_ROUTING;
    if (!r.escalate || o.escalated || o.usedModel === o.strongModel)
        return false;
    return !o.verdict || !o.verdict.patch_correct || o.verdict.confidence !== 'high';
}
/** Comment markers by file extension, for telling a comment-only change from a code change. */
const COMMENT = [
    [/\.(ts|tsx|js|jsx|mjs|cjs|c|h|cc|cpp|hpp|cs|java|kt|kts|go|rs|swift|scala|dart|php|css|scss|less)$/i, /^\s*(\/\/|\/\*|\*\/|\*(?!\*\/)|\/\*\*)/],
    [/\.(py|pyi|sh|bash|zsh|rb|pl|r|yaml|yml|toml|cfg|ini|conf|ps1|tf|Dockerfile|mk)$/i, /^\s*#(?!!)/],
    [/(^|\/)(Makefile|Dockerfile)$/, /^\s*#/],
    [/\.(sql|lua|hs|elm)$/i, /^\s*--/],
    [/\.(html|xml|svg|vue)$/i, /^\s*(<!--|-->)/],
];
/**
 * A change that only adds, edits or removes comments (and blank lines): every changed line, both sides, is a
 * comment or blank in a file whose comment syntax is known. Unknown file types are never comment-only.
 */
export function commentOnly(files) {
    if (!files.length)
        return false;
    return files.every((f) => {
        const syntax = COMMENT.find(([ext]) => ext.test(f.path));
        if (!syntax)
            return false;
        return [...f.addedLines, ...f.removedLines].every((l) => l.trim() === '' || syntax[1].test(l));
    });
}
//# sourceMappingURL=eval-routing.js.map