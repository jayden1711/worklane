// Held-out cases for the instruction-eval gate: a role's set from the coordinator's own state, or, when the
// instance has none yet, written now by a separate case-writer run from the base prompt's contract (never the
// prompt being changed) and kept there. No set means the change can't pass (src/merge-policy.ts).
import { heldOutDir, readHeldOut, writeHeldOut, writeHeldOutCases } from '../held-out.js';
/** run.cost role of a case-writer run. */
export const CASE_WRITER_COST_ROLE = 'eval-case-writer';
export async function heldOutFor(o) {
    const dir = heldOutDir(o.stateDir);
    const have = readHeldOut(dir, o.role);
    if (have)
        return { cases: have };
    try {
        // A new role has no base: its contract lines are all there is (the writer still sees nothing else of it).
        const { md } = await writeHeldOutCases({ role: o.role, prompt: o.baseText ?? o.headText, ask: o.ask, model: o.model });
        writeHeldOut(dir, o.role, md);
        return { cases: readHeldOut(dir, o.role) ?? [] };
    }
    catch (e) {
        return { error: `no held-out cases for role ${o.role}, and none could be written: ${e.message.slice(0, 300)}` };
    }
}
//# sourceMappingURL=held-out.js.map