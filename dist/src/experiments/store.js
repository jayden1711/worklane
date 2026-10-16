// The instance's own experiment pins, `<instance home>/experiments.yaml` (the coordinator user's, 0600): which studies
// an owner started, and what each was started at: its version, the commit its eval files were read from, those files'
// sha256 and the data sources' sha256. Written only by the dashboard's Review -> Confirm (plan writes nothing; apply
// re-plans and refuses a file that changed since). The repo defines studies; only this file starts one, so a merged
// change to a study, its eval or its data never runs until an owner confirms the new version.
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { parse, stringify } from 'yaml';
import { z } from 'zod';
import { writeOwnerOnly } from '../os/index.js';
import { ID } from './study.js';
import { APPROVE_DEFAULTS } from './approval.js';
export const PINS_FILE = 'experiments.yaml';
const hex = z.string().regex(/^[0-9a-f]{64}$/);
export const Pin = z.strictObject({
    version: z.string().regex(/^[0-9a-f]{16}$/),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    eval_files: z.record(z.string(), hex),
    sources: z.record(z.string().regex(ID), hex),
    started_by: z.string().max(100),
    started_at: z.string().max(40),
});
export const PinsFile = z.strictObject({
    version: z.literal(1),
    /** The instance's thresholds for an owner's approval (never above root's caps: those refuse a job outright). */
    approve: z.strictObject({ above_gb: z.number().int().min(1).max(99999) }).default({ ...APPROVE_DEFAULTS }),
    studies: z.record(z.string().regex(ID), Pin).default({}),
});
export const EMPTY_PINS = { version: 1, approve: { ...APPROVE_DEFAULTS }, studies: {} };
/** The pins, or why they can't be read (a file anyone else can read or write is refused, as intake.yaml is). */
export function loadPins(file) {
    if (!existsSync(file))
        return { pins: EMPTY_PINS, text: '' };
    const st = lstatSync(file);
    if (!st.isFile())
        return { error: `${file} is not a regular file` };
    if (typeof process.getuid === 'function' && (st.mode & 0o077) !== 0)
        return { error: `${file} is open to other users (mode ${(st.mode & 0o777).toString(8)}); make it 0600` };
    const text = readFileSync(file, 'utf8');
    try {
        return { pins: PinsFile.parse(parse(text) ?? {}), text };
    }
    catch (e) {
        return { error: `${file}: ${e.message.slice(0, 500)}` };
    }
}
export function planPins(file, change) {
    const cur = loadPins(file);
    if ('error' in cur)
        return cur;
    const next = PinsFile.parse(change(structuredClone(cur.pins)));
    return { before: cur.text, after: stringify(next), next };
}
/** Write a planned change, only if the file is still what the plan read (else: review again). */
export function applyPins(file, plan) {
    const cur = loadPins(file);
    if ('error' in cur)
        return cur;
    if (cur.text !== plan.before)
        return { error: 'the experiments file changed since you reviewed it; review again' };
    writeOwnerOnly(file, plan.after);
    return { ok: true };
}
//# sourceMappingURL=store.js.map