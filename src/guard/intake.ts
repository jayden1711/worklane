// The intake run's tools, as the agents' tool guard (src/hook.ts) holds them: read tools only, whatever lane or
// settings it runs under. src/intake/run.ts and the coordinator's intake runs use them too.
// INVARIANT (#785): imports nothing (see src/guard/research.ts for what a guard module may import).

export const INTAKE_ROLE = 'intake';
export const INTAKE_TOOLS = ['Read', 'Glob', 'Grep'] as const;
/** Named as disallowed too, so a project's pre-approved tools or settings can't add them back. */
export const INTAKE_DENIED = ['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Task', 'WebSearch', 'WebFetch', 'mcp__*'] as const;
