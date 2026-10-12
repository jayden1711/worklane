// The shape every role's instructions take: a contract, not a title. Each part starts a line with its label, in
// this order, and has text (on that line, or in the lines under it, up to the next part).
//   Own:      the one outcome it's accountable for.
//   Sources:  exactly what it may read.
//   Output:   format and destination.
//   Approval: what it must never do without the owner.
//   Failure:  if a source is missing, stale or contradictory, report it; never guess or fill from memory.
//   Never:    the two or three things it must not touch.
// Kept apart from src/roles.ts, which scripts/eval-roles.mjs loads on its own (node built-ins and types only).

export const CONTRACT_PARTS = ['Own', 'Sources', 'Output', 'Approval', 'Failure', 'Never'] as const;

/** The Failure rule every role states, word for word. */
export const FAILURE_RULE = 'If a source is missing, stale or contradictory, report it; never guess or fill from memory.';

/** What is wrong with a role prompt's shape ([] when it follows the contract). */
export function contractProblems(prompt: string): string[] {
  const lines = prompt.replace(/\r\n/g, '\n').split('\n');
  const at = CONTRACT_PARTS.map((p) => lines.findIndex((l) => l.startsWith(`${p}:`)));
  const problems: string[] = [];
  CONTRACT_PARTS.forEach((p, i) => {
    if (at[i]! < 0) return void problems.push(`missing "${p}:"`);
    const next = at.filter((x) => x > at[i]!).sort((a, b) => a - b)[0] ?? lines.length;
    const text = [lines[at[i]!]!.slice(p.length + 1), ...lines.slice(at[i]! + 1, next)].join('\n').trim();
    if (!text) problems.push(`"${p}:" is empty`);
  });
  const found = at.filter((x) => x >= 0);
  if (found.some((x, i) => i > 0 && x < found[i - 1]!)) problems.push(`the parts are out of order (${CONTRACT_PARTS.join(', ')})`);
  if (at[4]! >= 0 && !lines[at[4]!]!.includes(FAILURE_RULE)) problems.push(`"Failure:" must state: ${FAILURE_RULE}`);
  return problems;
}
