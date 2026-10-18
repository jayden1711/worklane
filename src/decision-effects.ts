// A decision in plain words: what happened, and what each answer does and can't do. The decision card (the state's
// decisions, src/projection.ts) and the decision's detail (src/decision-detail.ts) both say it from here, so the card
// needs no detail request to say what each choice does.
import { BRAND } from './brand.js';
import type { EventPayload } from './events/types.js';
import type { PrView } from './projection.js';

export type DetailKind = EventPayload<'decision.asked'>['kind'] | 'pr';

/** An investigation's options: a question with all three is an investigation's (src/roles.ts INVESTIGATION_OPTIONS). */
const INVESTIGATION = ['approve-fix', 'investigate-more', 'close'] as const;

/** Whether a decision is an investigation's "how should this proceed?". */
export const isInvestigation = (kind: string, options: readonly string[]): boolean => kind === 'question' && INVESTIGATION.every((o) => options.includes(o));

/** What each answer does, by kind and option, in plain words; and what it can't do. */
export function optionEffect(kind: DetailKind, option: string, o: { investigation?: boolean } = {}): { does: string; cannot: string } {
  const cli = BRAND.cli;
  if (kind === 'land') {
    if (option === 'approve') return { does: 'Queues the change, at the commit that was reviewed, to land on the default branch. The land queue runs the checks again before it lands.', cannot: "It can't land any other commit: a later push needs its own review." };
    if (option === 'reject') return { does: "Doesn't land it. The issue gets a comment saying so and the task is released.", cannot: "It doesn't close the issue or delete the branch." };
  }
  if (kind === 'question' && o.investigation) {
    if (option === 'approve-fix') return { does: 'Comments on the issue that a fix is approved. Nothing is built until the fix has its own list of the checks that decide it is done (in this issue or a new one).', cannot: 'It never writes code by itself: investigations never turn into code changes on their own.' };
    if (option === 'investigate-more') return { does: 'Releases the task and requeues it: the next run gets your answer in its brief.', cannot: "It doesn't say what to look at: comment on the issue for that." };
    if (option === 'close') return { does: 'Comments that you closed the investigation, and closes the issue.', cannot: 'Nothing is fixed: no code changes.' };
  }
  if (kind === 'question') return { does: 'Releases the task and requeues it, marked ready: the next run gets this answer in its brief.', cannot: "It doesn't change code itself: the next run decides how to act on your answer." };
  if (kind === 'domain') {
    if (option === 'allow-repo') return { does: "Proposes a config change (a PR you review) that allows this host for the repo's agents.", cannot: "Nothing is allowed until you merge that PR." };
    if (option === 'allow-once') return { does: "The task's next run may reach the host.", cannot: 'Later runs may not: it is refused again after that run.' };
    if (option === 'deny') return { does: 'Nothing changes: the host stays refused.', cannot: "The agent can't reach it; it works without it or asks again." };
  }
  if (kind === 'plan') {
    if (option === 'approve') return { does: 'The plan is built: the task goes on to its workers.', cannot: "It doesn't approve the code: the change is reviewed again at its own level." };
    if (option === 'revise') return { does: 'The planner plans again, with your note (comment `/' + cli + ' revise <note>` on the issue to give one).', cannot: 'Nothing is built until a plan is approved.' };
    if (option === 'reject') return { does: 'Stops the task: nothing is built.', cannot: "It doesn't close the issue." };
  }
  if (kind === 'intake') {
    if (option === 'approve') return { does: 'Files the report as an issue, marked ready, so it is built.', cannot: "It doesn't trust the sender for later reports." };
    if (option === 'edit') return { does: 'Files the report as an issue without ready, for you to edit first. A report that came in as a GitHub issue is worked from its checked draft whatever is edited on GitHub: to work it differently, open a new issue.', cannot: 'Nothing is built until you mark it ready.' };
    if (option === 'reject') return { does: 'Drops the report, and the sender is told it was declined.', cannot: 'No issue is filed.' };
    if (option === 'answered') return { does: 'Marks the question answered.', cannot: "It doesn't send your answer: reply to the sender yourself." };
  }
  if (kind === 'automation') {
    if (option === 'approve') return { does: "Runs the automation once for this trigger, if its caps and budgets still allow it now (they are checked again).", cannot: "It doesn't approve later triggers: each run asks again." };
    if (option === 'reject') return { does: "Doesn't run it for this trigger.", cannot: "It doesn't pause the automation: pause it on Extend." };
  }
  if (kind === 'delegation') {
    if (option === 'loosen' || option === 'tighten') return { does: `Files the review.yaml change as an issue: the harness then ${option === 'loosen' ? 'stops waiting for you on' : 'waits for you again on'} that category, once its PR is merged.`, cannot: 'Nothing changes before that PR is reviewed and merged.' };
    if (option === 'keep') return { does: 'Nothing changes.', cannot: "It won't be suggested again until the record changes." };
  }
  return { does: 'Recorded as your answer: the coordinator acts on it at its next tick.', cannot: "It can't do anything the coordinator wasn't built to do with this answer." };
}

/** Every option of a decision with what it does and can't, in the decision's order. */
export function optionEffects(kind: DetailKind, options: readonly string[]): { option: string; does: string; cannot: string }[] {
  const investigation = isInvestigation(kind, options);
  return options.map((option) => ({ option, ...optionEffect(kind, option, { investigation }) }));
}

/**
 * What happened, in one plain sentence: a decision card's first line and the detail's summary. Where the question
 * itself says what is asked (an agent's question, a host, a report, an automation, a review setting), it ends the
 * sentence; a landing, a plan and an investigation say it in words of their own, so their question (with its review
 * level) stays in Details.
 */
export function happened(kind: DetailKind, issue: number | null, question: string, o: { investigation: boolean; pr?: PrView | null }): string {
  const on = issue !== null ? ` on #${issue}` : '';
  const q = question.trim();
  const asks = (lead: string) => (q ? `${lead}: ${q}` : `${lead}.`);
  switch (kind) {
    case 'land':
      return `An agent's change${on} passed its checks and the evaluator, and it waits for your approval before it lands.`;
    case 'question':
      return o.investigation ? `An investigation${on} finished and asks how to go on: nothing is changed until you say.` : asks(issue !== null ? `The agent working${on} stopped to ask you rather than guess` : 'A question for you');
    case 'domain':
      return asks(`An agent's run${on} tried to reach a host outside its allowlist and was refused`);
    case 'plan':
      return `The plan${on} is held for your approval: nothing is built before it.`;
    case 'intake':
      return asks('A report came in from a sender who is not trusted, and needs your OK before it becomes an issue');
    case 'automation':
      return asks("An automation was triggered and waits for its owner's approval before each run");
    case 'delegation':
      return asks('The review history of a category of changes suggests changing whether it waits for you');
    case 'pr':
      return `PR #${o.pr?.number ?? '?'}${on} was left to a person by the merge policy${o.pr?.waitReasons.length ? `: ${o.pr.waitReasons.join('; ')}` : ''}.`;
  }
}
