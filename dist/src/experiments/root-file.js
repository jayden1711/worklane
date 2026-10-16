// Root's file for one instance's experiment jobs, /etc/<cli>/experiments/<name>.json (root:root 0644, written only by
// scripts/setup/experiments.sh): its GPUs, the most minutes a job may run, GPU-hours a day, output size, whether the
// environment build may use the network, and the approved data sources with their sha256 and who may read them.
// The helper reads it itself and decides from it alone. The engine reads it only to plan and to show it: nothing here
// grants anything, and a file the helper would refuse is "off" here too.
import { lstatSync, readFileSync } from 'node:fs';
import { etcPath } from '../os/system-paths.js';
export const rootFilePath = (instance) => etcPath(`experiments/${instance}.json`);
/** The root script that changes it, as a root shell runs it. */
export const EXP_SCRIPT = 'scripts/setup/experiments.sh';
/** The file's text exactly as the script writes it (and the helper reads it). */
export function rootFileText(f) {
    const ids = Object.keys(f.sources).sort();
    const head = `{\n  "version": 1,\n  "devices": [${f.devices.join(', ')}],\n  "max_minutes": ${f.max_minutes},\n  "gpu_hours_per_day": ${f.gpu_hours_per_day},\n  "output_gb": ${f.output_gb},\n  "env_network": ${f.env_network},\n  "tasks_max": ${f.tasks_max},\n  "memory_gb": ${f.memory_gb},\n  "cpu_cores": ${f.cpu_cores},\n`;
    if (!ids.length)
        return `${head}  "sources": {}\n}\n`;
    const lines = ids.map((id, i) => `    "${id}": { "sha256": "${f.sources[id].sha256}", "visibility": "${f.sources[id].visibility}" }${i < ids.length - 1 ? ',' : ''}`);
    return `${head}  "sources": {\n${lines.join('\n')}\n  }\n}\n`;
}
/** The file, or why it isn't one the helper reads: valid JSON in exactly the script's form, nothing more. */
export function parseRootFile(text) {
    const bad = { error: 'not in the form scripts/setup/experiments.sh writes' };
    let j;
    try {
        j = JSON.parse(text);
    }
    catch {
        return bad;
    }
    if (!j || typeof j !== 'object' || Array.isArray(j))
        return bad;
    const o = j;
    const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
    if (o.version !== 1 || !Array.isArray(o.devices) || o.devices.length > 16 || !o.devices.every((d) => int(d, 0, 99)))
        return bad;
    if (!int(o.max_minutes, 1, 1440) || !int(o.gpu_hours_per_day, 1, 999) || !int(o.output_gb, 1, 99999) || typeof o.env_network !== 'boolean')
        return bad;
    if (!int(o.tasks_max, 16, 100000) || !int(o.memory_gb, 1, 9999) || !int(o.cpu_cores, 1, 999))
        return bad;
    if (!o.sources || typeof o.sources !== 'object' || Array.isArray(o.sources))
        return bad;
    const sources = {};
    for (const [id, v] of Object.entries(o.sources)) {
        const s = v;
        if (!/^[a-z][a-z0-9-]{0,39}$/.test(id) || typeof s?.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(s.sha256) || (s.visibility !== 'job' && s.visibility !== 'scorer'))
            return bad;
        sources[id] = { sha256: s.sha256, visibility: s.visibility };
    }
    const f = { devices: o.devices, max_minutes: o.max_minutes, gpu_hours_per_day: o.gpu_hours_per_day, output_gb: o.output_gb, env_network: o.env_network, tasks_max: o.tasks_max, memory_gb: o.memory_gb, cpu_cores: o.cpu_cores, sources };
    return rootFileText(f) === text ? f : bad;
}
/** Root's file for `instance` as the helper would read it: root's, 0644, regular, in the script's form. */
export function readRootFile(instance, file = rootFilePath(instance), rootUid = 0) {
    let st;
    try {
        st = lstatSync(file);
    }
    catch (e) {
        if (e.code === 'ENOENT')
            return { state: 'off', why: `experiments are off for ${instance} on this machine (no root file)` };
        return { state: 'unknown', why: `${file} can't be read: ${e.message}` };
    }
    if (!st.isFile() || st.uid !== rootUid || (st.mode & 0o777) !== 0o644)
        return { state: 'off', why: `${file} is not root's regular 0644 file, so the helper runs nothing` };
    let text;
    try {
        text = readFileSync(file, 'utf8');
    }
    catch (e) {
        return { state: 'unknown', why: `${file} can't be read: ${e.message}` };
    }
    const f = parseRootFile(text);
    return 'error' in f ? { state: 'off', why: `${file} is ${f.error}` } : { state: 'on', file: f };
}
/** The commands an owner runs in a root shell (the dashboard shows them; it never runs them). */
export const rootCommands = (instance) => ({
    install: `sudo bash ${EXP_SCRIPT} install ${instance}`,
    set: `sudo bash ${EXP_SCRIPT} set ${instance} --devices 0 --max-minutes 20 --gpu-hours 8 --output-gb 50`,
    hash: `bash ${EXP_SCRIPT} data hash <path>`,
    add: `sudo bash ${EXP_SCRIPT} data add ${instance} <id> --from <path> --sha256 <hex> --visibility job|scorer`,
});
//# sourceMappingURL=root-file.js.map