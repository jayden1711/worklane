// How the dashboard shows a changed path: the engine's own rule (src/path-text.ts), imported rather than copied, so a
// page shows a name the way every reason, event, question and comment does (#768). A bidi override, a zero-width or
// a control character in a name shows escaped and can't reorder or hide the text around it. The data stays raw: only
// the text a person reads goes through here. test/web-shown-path.test.ts fails when a page shows a path field without it.
export { shownPath, shownPaths } from '../../src/path-text';
