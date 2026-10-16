// The intake agent's run: read-only, sandboxed as the instance's agent user, holding no token, with no shell, no
// web and no write tool. It reads a per-report bundle the coordinator writes (the redacted report, candidate issues
// and recent reports) and, only when the owner turned research repo access on, the repo. Its lane is the research
// lane (which denies every read of the checkout) or the research-repo lane; its tools and output schema are fixed
// here, before any report text is read.
//
// The bundle lives under the research bundles' root: the research lane's hook refuses every read outside it.
import { join } from 'node:path';
import { writeBundle } from '../bundle.js';
import { RESEARCH_DIR, RESEARCH_LANE, RESEARCH_REPO_LANE } from '../research.js';
import { defaultRolePrompt } from '../roles.js';
import { INTAKE_SCHEMA } from './triage.js';
export const INTAKE_ROLE = 'intake';
export const INTAKE_TOOLS = ['Read', 'Glob', 'Grep'];
/** Named as disallowed too, so a project's pre-approved tools or settings can't add them back. */
export const INTAKE_DENIED = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'WebSearch', 'WebFetch', 'mcp__*'];
/** The intake agent's instructions: kept with the other roles (src/roles.ts), where the instruction evals reach them. */
export const INTAKE_PROMPT = defaultRolePrompt('intake');
/**
 * The per-report bundle: what the intake agent may read. `name`: the bundle's name (default `intake-<id>`);
 * `decisions`: the decisions already made, for a conversation (decisions.md).
 */
export function writeIntakeBundle(o) {
    return writeBundle(join(o.instanceRoot, RESEARCH_DIR), o.name ?? `intake-${o.id}`, o.gid, {
        'report.md': `# Report (via ${o.source})\n\n${o.redacted}\n`,
        'candidates.json': JSON.stringify(o.candidates, null, 2),
        'recent.json': JSON.stringify(o.recent.slice(0, 20), null, 2),
        ...(o.decisions !== undefined ? { 'decisions.md': o.decisions } : {}),
    });
}
/**
 * The fixed parts of an intake run request. Without repo access it works in its bundle (research lane); with it, in
 * the checkout `repo` (research-repo lane, under the project's own hook), reading the bundle by its path.
 */
export function intakeRun(o) {
    const withRepo = o.repoAccess;
    // A conversation with a person of the project (src/coordinator/conversation.ts): what they said so far, and
    // what is decided already. Questions back to them are the reply, all in one message.
    const talk = o.conversation
        ? `\n\nThis report is a conversation with a person of the project, in the thread so far (report.md: what they said, and what you asked before). decisions.md lists the decisions already made. Before you ask anything, check the conversation, decisions.md${withRepo ? ' and the repository' : ''}: ask only what none of them settles and you can't reasonably choose yourself, all of it in one reply. If nothing is left to ask, return the draft.`
        : '';
    return {
        role: INTAKE_ROLE,
        lane: withRepo ? RESEARCH_REPO_LANE : RESEARCH_LANE,
        cwd: withRepo ? o.repo : o.bundleDir,
        allowedTools: [...INTAKE_TOOLS],
        disallowedTools: [...INTAKE_DENIED],
        appendSystemPrompt: INTAKE_PROMPT + (withRepo ? `\n\nThe bundle is in ${o.bundleDir}. You may read the repository (your working directory, read-only) to locate or reproduce the problem.` : '\n\nYou have no access to the repository; work from the bundle only (your working directory).') + talk,
        prompt: withRepo ? `Triage the report in ${join(o.bundleDir, 'report.md')}.` : 'Triage the report in report.md.',
        jsonSchema: INTAKE_SCHEMA,
    };
}
//# sourceMappingURL=run.js.map