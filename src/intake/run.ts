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
import type { Candidate } from './dedupe.js';
import { INTAKE_SCHEMA } from './triage.js';

export const INTAKE_ROLE = 'intake';
export const INTAKE_TOOLS = ['Read', 'Glob', 'Grep'] as const;
/** Named as disallowed too, so a project's pre-approved tools or settings can't add them back. */
export const INTAKE_DENIED = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'WebSearch', 'WebFetch', 'mcp__*'] as const;

/** The intake agent's instructions: kept with the other roles (src/roles.ts), where the instruction evals reach them. */
export const INTAKE_PROMPT = defaultRolePrompt('intake');

/** The per-report bundle: what the intake agent may read. */
export function writeIntakeBundle(o: { instanceRoot: string; gid: number; id: string; redacted: string; source: string; candidates: Candidate[]; recent: { id: string; text: string }[] }): string {
  return writeBundle(join(o.instanceRoot, RESEARCH_DIR), `intake-${o.id}`, o.gid, {
    'report.md': `# Report (via ${o.source})\n\n${o.redacted}\n`,
    'candidates.json': JSON.stringify(o.candidates, null, 2),
    'recent.json': JSON.stringify(o.recent.slice(0, 20), null, 2),
  });
}

/**
 * The fixed parts of an intake run request. Without repo access it works in its bundle (research lane); with it, in
 * the checkout `repo` (research-repo lane, under the project's own hook), reading the bundle by its path.
 */
export function intakeRun(o: { bundleDir: string; repoAccess: boolean; repo: string }) {
  const withRepo = o.repoAccess;
  return {
    role: INTAKE_ROLE,
    lane: withRepo ? RESEARCH_REPO_LANE : RESEARCH_LANE,
    cwd: withRepo ? o.repo : o.bundleDir,
    allowedTools: [...INTAKE_TOOLS],
    disallowedTools: [...INTAKE_DENIED],
    appendSystemPrompt: INTAKE_PROMPT + (withRepo ? `\n\nThe bundle is in ${o.bundleDir}. You may read the repository (your working directory, read-only) to locate or reproduce the problem.` : '\n\nYou have no access to the repository; work from the bundle only (your working directory).'),
    prompt: withRepo ? `Triage the report in ${join(o.bundleDir, 'report.md')}.` : 'Triage the report in report.md.',
    jsonSchema: INTAKE_SCHEMA,
  };
}
