// Context bundles: what the coordinator hands an agent that may not read the instance's private state or (for some
// roles) the repo. Written by the coordinator, per run, into a directory beside the checkout that the agents' group
// can read but not write (2750; files 0640; the parent made sticky so it can't be swapped; a directory not owned by
// the coordinator is refused). Every text file is redacted with the event log's secret patterns first.
// Shared by research runs and the dashboard chat, so the two never diverge.
import { join } from 'node:path';
import { redactString } from './events/redact.js';
import { agentReadableDir, writeAgentReadable } from './os/index.js';
/** Bundle file names: plain names only, so a bundle can never write outside its directory. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
/**
 * Write a bundle: `files` (name -> text) into `root/<id>/`, readable by group `gid` only. Returns the directory.
 * Text is redacted; names that aren't plain file names, or an id that isn't one, are refused. `binary`: files kept
 * byte for byte (a chat's image attachment, for the Read tool to view), under the same name rules.
 */
export function writeBundle(root, id, gid, files, binary = {}) {
    if (!NAME.test(id))
        throw new Error(`bundle id ${JSON.stringify(id)} is not a plain name`);
    for (const n of [...Object.keys(files), ...Object.keys(binary)])
        if (!NAME.test(n))
            throw new Error(`bundle file ${JSON.stringify(n)} is not a plain name`);
    agentReadableDir(root, gid);
    const dir = join(root, id);
    agentReadableDir(dir, gid);
    for (const [n, text] of Object.entries(files))
        writeAgentReadable(join(dir, n), redactString(text), gid);
    for (const [n, data] of Object.entries(binary))
        writeAgentReadable(join(dir, n), data, gid);
    return dir;
}
//# sourceMappingURL=bundle.js.map