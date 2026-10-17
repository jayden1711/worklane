import { redactString } from '../events/redact.js';
import { researchComment } from '../research.js';
import { acceptResearchRequest, MAX_REQUESTS_PER_TASK, researchBriefSection, researchRequestHold } from '../research-request.js';
import { researchCaps } from '../settings.js';
import { ResearchRuns } from './research.js';
/** The run.cost role of a researcher run started for a worker's or evaluator's request. */
export const ON_DEMAND_COST_ROLE = 'research-on-demand';
export class ResearchOnDemand extends ResearchRuns {
    /**
     * Answer one research request from `from` on this issue. Returns the section for the resumed run's brief: the
     * cited answer, or, when there is none (refused, held by a cap or the per-task limit, or the run found nothing
     * it could cite), why, and to go on with what the repository shows. Never throws for a bad request.
     */
    async answerResearch(issue, raw, path, from) {
        const n = issue.number;
        const r = (raw ?? {});
        const got = acceptResearchRequest(raw);
        const question = got.ok ? got.request.question : redactString(String(r.question ?? '')).slice(0, 500);
        const why = got.ok ? got.request.why : redactString(String(r.why ?? '')).slice(0, 500);
        const held = got.ok
            ? researchRequestHold({ events: this.d.log.read(0, ['research.searched', 'research.fetched', 'run.cost', 'research.requested']), issue: n, caps: researchCaps(this.d.settings?.().settings ?? {}), day: new Date().toISOString().slice(0, 10) })
            : got.why;
        this.emit('research.requested', { issue: n, role: from, question, why, held });
        const none = (reason) => ['## Research you asked for', '', `**Question:** ${question || '(none)'}`, '', `Not answered: ${reason}. Go on with what the repository shows; if the task can't be done without it, say so (for a worker: set "blocked" with what you need).`].join('\n');
        if (held || !got.ok)
            return none(held ?? 'the request was not taken');
        const res = await this.runResearcher(issue, [got.request.question], path, ON_DEMAND_COST_ROLE);
        if (!res.ok)
            return none(res.why);
        this.emit('research.reported', { issue: n, run: res.run, sources: res.result.sources.length, ignored: res.ignored, report: res.result.report.slice(0, 4000) });
        await this.d.backlog.comment(n, researchComment(res.result, res.steps));
        return researchBriefSection(got.request, res.result);
    }
}
export { MAX_REQUESTS_PER_TASK };
//# sourceMappingURL=research-on-demand.js.map