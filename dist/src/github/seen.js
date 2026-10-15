// When a GitHub call last got a successful answer with an instance's credential, kept in memory per token source (the
// function the coordinator's GitHub clients get their token from). The watchdog runs in the same process with the
// same token source, so it reads here that GitHub works again from calls the coordinator makes anyway: no call of its own.
const lastOk = new WeakMap();
/** A GitHub call made with `source`'s token was answered with a success (2xx). */
export function noteGitHubOk(source, at = Date.now()) {
    if ((lastOk.get(source) ?? -Infinity) < at)
        lastOk.set(source, at);
}
/** When a call with `source`'s token last succeeded (ms), or null: none has in this process. */
export function githubOkAt(source) {
    return lastOk.get(source) ?? null;
}
//# sourceMappingURL=seen.js.map