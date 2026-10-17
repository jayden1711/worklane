// Where held-out eval cases live, kept apart from src/held-out.ts so the hook (run on every tool call) loads only this.
import { BRAND } from './brand.js';
/** Overrides where the held-out cases live (for an instance, or tests). */
export const HELD_OUT_ENV = `${BRAND.envPrefix}_HELD_OUT_DIR`;
/** Every agent session is denied any path under a held-out store, wherever it is (src/hook.ts). */
export const HELD_OUT_GLOB = '/**/evals/held-out/**';
//# sourceMappingURL=held-out-paths.js.map