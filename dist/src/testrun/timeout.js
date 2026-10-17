// How a test-run step stopped at its own cap reads on its check. Its own module, with no imports: the real-systemd CI
// job prints it from the engine's build with nothing but zod beside it.
/** Each setup step's cap (the tiers have their own, test_run.tiers[].timeout_s). */
export const SETUP_TIMEOUT_S = 1800;
/** A step stopped at its own cap, as its check says it: "tier e2e timed out after 30 min (its timeout_s, 1800)". */
export function timedOutLine(what, seconds, field) {
    const after = seconds < 60 ? `${seconds} s` : seconds % 60 === 0 ? `${seconds / 60} min` : `${Math.round(seconds / 6) / 10} min`;
    return `${what} timed out after ${after} (${field}, ${seconds})`;
}
//# sourceMappingURL=timeout.js.map