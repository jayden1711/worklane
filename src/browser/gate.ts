// Which browser checks a task runs (Track B). An issue that asks (a `browser:` item in its done_when) runs the
// flows it names, always: with no app declared they come back unavailable, never skipped as passed. Otherwise a
// change that touches the app's ui_paths runs every flow the app declares; anything else runs none and pays
// nothing. A project without an app runs none unless asked.
import type { AppConfig } from '../config/schema.js';
import { globRegExp } from '../guardrails/glob.js';
import { BrowserDoneWhenItem } from './check.js';

export interface BrowserGate {
  /** The flows to run, in order; empty when none. */
  flows: string[];
  /** Why, in a line, for the run's log and the PR's evidence. */
  reason: string;
  /** The changed files under ui_paths (at most 10), when that's why. */
  uiFiles: string[];
}

/** Changed files under the app's ui_paths, repo-relative with forward slashes (git's form, on every OS). */
export function uiFilesTouched(app: AppConfig, changed: readonly string[]): string[] {
  const res = app.ui_paths.map((g) => globRegExp(g, 'deny'));
  return changed.map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')).filter((f) => res.some((re) => re.test(f)));
}

/** The flows an issue's done_when asks for, in its order. */
export function askedFlows(doneWhen: readonly unknown[]): string[] {
  return doneWhen.flatMap((d) => {
    const r = BrowserDoneWhenItem.safeParse(d);
    return r.success ? [r.data.browser] : [];
  });
}

export function browserGate(o: { app: AppConfig | undefined; changed: readonly string[]; asked: readonly string[] }): BrowserGate {
  const asked = [...new Set(o.asked)];
  if (asked.length) return { flows: asked, reason: `the issue asks for ${asked.length === 1 ? 'the browser check' : 'browser checks'} ${asked.join(', ')}`, uiFiles: [] };
  if (!o.app) return { flows: [], reason: 'no app is declared, so no browser checks', uiFiles: [] };
  const ui = uiFilesTouched(o.app, o.changed);
  if (!ui.length) return { flows: [], reason: 'the change touches none of the app\'s ui_paths, so no browser checks', uiFiles: [] };
  const flows = Object.keys(o.app.flows);
  return { flows, reason: `the change touches ${ui.length} file(s) under ui_paths, so every flow runs`, uiFiles: ui.slice(0, 10) };
}
