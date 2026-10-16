import { globToRegExp } from '../guardrails/glob.js';
import { BrowserDoneWhenItem } from './check.js';
/** Changed files under the app's ui_paths, repo-relative with forward slashes (git's form, on every OS). */
export function uiFilesTouched(app, changed) {
    const res = app.ui_paths.map(globToRegExp);
    return changed.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')).filter((f) => res.some((re) => re.test(f)));
}
/** The flows an issue's done_when asks for, in its order. */
export function askedFlows(doneWhen) {
    return doneWhen.flatMap((d) => {
        const r = BrowserDoneWhenItem.safeParse(d);
        return r.success ? [r.data.browser] : [];
    });
}
export function browserGate(o) {
    const asked = [...new Set(o.asked)];
    if (asked.length)
        return { flows: asked, reason: `the issue asks for ${asked.length === 1 ? 'the browser check' : 'browser checks'} ${asked.join(', ')}`, uiFiles: [] };
    if (!o.app)
        return { flows: [], reason: 'no app is declared, so no browser checks', uiFiles: [] };
    const ui = uiFilesTouched(o.app, o.changed);
    if (!ui.length)
        return { flows: [], reason: 'the change touches none of the app\'s ui_paths, so no browser checks', uiFiles: [] };
    const flows = Object.keys(o.app.flows);
    return { flows, reason: `the change touches ${ui.length} file(s) under ui_paths, so every flow runs`, uiFiles: ui.slice(0, 10) };
}
//# sourceMappingURL=gate.js.map