// Importing this module silences one warning: node:sqlite's "ExperimentalWarning: SQLite is an experimental
// feature and might change at any time", which Node prints on stderr the first time the module loads.
//
// WHY: the engine's state is SQLite, so every command printed it, into hook output, service logs and the terminal.
// Only that warning goes: every other warning (experimental or not) still reaches Node's own printer. So no
// --no-warnings and no NODE_NO_WARNINGS, which would hide them all.
//
// Node emits a warning as a 'warning' event on a later tick and prints it from a listener of its own. This takes
// that listener's place and passes everything else on to it. An entry point imports it first; the import only has
// to run before the first tick ends, which any static import does.
/** Whether `w` is node:sqlite's experimental-feature warning, and nothing else. */
export function isSqliteExperimentalWarning(w) {
    return w.name === 'ExperimentalWarning' && /^SQLite is an experimental feature\b/.test(w.message);
}
/** Put the filter in front of the warning printers there are now. Doing it twice changes nothing. */
export function silenceSqliteExperimentalWarning() {
    if (process.listeners('warning').some((l) => l.name === sqliteWarningFilter.name))
        return;
    printers = process.listeners('warning');
    process.removeAllListeners('warning');
    process.on('warning', sqliteWarningFilter);
}
let printers = [];
function sqliteWarningFilter(w) {
    if (isSqliteExperimentalWarning(w))
        return;
    for (const print of printers)
        print.call(process, w);
}
silenceSqliteExperimentalWarning();
//# sourceMappingURL=quiet-sqlite.js.map