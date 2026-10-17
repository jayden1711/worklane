// WHY: item 33 wiring (src/learnings.ts): notes when a task ends, and an owner's promote filed as an AGENTS.md PR
// built from the default branch with git plumbing (no worktree, no agent), labelled review:L3, never merged here.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BRAND } from '../brand.js';
import { AGENTS_MD, taskNotes, withLearning } from '../learnings.js';
import { checkedPush } from '../push-check.js';
import { readRun, runsForIssue } from '../run-record.js';
import { ChecksFromFeedback } from './checks-from-feedback.js';
export const PROMOTE_LEVEL_LABEL = 'review:L3';
export class Learnings extends ChecksFromFeedback {
    noteLearnings(issue, doneWhen = []) {
        const records = runsForIssue(this.d.stateDir, issue)
            .map((r) => readRun(this.d.stateDir, r.id))
            .filter((r) => r !== null);
        const notes = taskNotes(this.d.log.read(), issue, records, doneWhen);
        for (const n of notes)
            this.emit('learning.noted', n);
        return notes.length;
    }
    async promoteLearnings() {
        for (const ask of this.d.log.read(0, ['learning.promote_requested'])) {
            // INVARIANT: a learning.promoted after a request (filed or failed) answers it and every earlier one for it.
            const p = ask.payload;
            if (this.d.log.read(ask.id, ['learning.promoted']).some((r) => r.payload.fingerprint === p.fingerprint))
                continue;
            let pr = null;
            let detail = '';
            try {
                const r = await this.fileAgentsMdPr(p.fingerprint, p.line, p.by);
                pr = r.pr;
                detail = r.detail;
            }
            catch (e) {
                detail = e.message.slice(0, 500);
            }
            this.emit('learning.promoted', { fingerprint: p.fingerprint, line: p.line, by: p.by, pr: pr?.url ?? null, number: pr?.number ?? null, detail });
        }
    }
    async fileAgentsMdPr(fp, line, by) {
        this.git(this.d.repo, 'fetch', '-q', this.remote, this.branch);
        const base = this.git(this.d.repo, 'rev-parse', `${this.remote}/${this.branch}`);
        const shown = spawnSync('git', ['show', `${base}:${AGENTS_MD}`], { cwd: this.d.repo, encoding: 'utf8' });
        const next = withLearning(shown.status === 0 ? shown.stdout : null, line);
        if (next === null)
            return { pr: null, detail: `the line is in ${AGENTS_MD} on ${this.branch} already` };
        const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: this.d.repo, encoding: 'utf8', input: next }).stdout.trim();
        mkdirSync(this.d.stateDir, { recursive: true });
        const index = join(this.d.stateDir, `learning-${randomBytes(3).toString('hex')}.index`);
        const env = { ...process.env, GIT_INDEX_FILE: index, GIT_AUTHOR_NAME: this.identity.name, GIT_AUTHOR_EMAIL: this.identity.email, GIT_COMMITTER_NAME: this.identity.name, GIT_COMMITTER_EMAIL: this.identity.email };
        const g = (args, input) => {
            const r = spawnSync('git', args, { cwd: this.d.repo, encoding: 'utf8', env, ...(input !== undefined ? { input } : {}) });
            if (r.status !== 0)
                throw new Error(`git ${args[0]} failed: ${(r.stderr || '').trim().slice(-300)}`);
            return r.stdout.trim();
        };
        const title = `${AGENTS_MD}: promote a learning seen repeatedly`;
        let head;
        try {
            g(['read-tree', base]);
            g(['update-index', '--cacheinfo', `100644,${blob},${AGENTS_MD}`]);
            head = g(['commit-tree', g(['write-tree']), '-p', base], `${title}\n\n@${by} promoted learning ${fp}:\n${line}\n`);
        }
        finally {
            rmSync(index, { force: true });
        }
        const branch = `${BRAND.cli}/learning-${fp}`;
        const push = checkedPush({ cwd: this.d.repo, remote: this.remote, base, head, ref: `refs/heads/${branch}`, limits: this.d.cfg.guardrails.push, guard: this.pushGuard(), force: true });
        if (!push.ok)
            return { pr: null, detail: `the ${AGENTS_MD} change couldn't be pushed: ${'refused' in push ? push.refused.join('; ') : push.error.split('\n').pop()}` };
        const body = [
            `Risk: protected (agent instructions), ${PROMOTE_LEVEL_LABEL}. It waits for the owner and is never auto-merged.`,
            '',
            `@${by} promoted learning \`${fp}\` from the dashboard's Learnings panel. It adds one line to \`${AGENTS_MD}\` under "Learnings":`,
            '',
            `> ${line}`,
        ].join('\n');
        const opened = await this.d.backlog.openPr(branch, this.branch, title, body);
        // WHY: the PR is open either way; a missing label is reported, and the merge policy holds AGENTS.md regardless.
        const labelled = await this.d.backlog.addLabels(opened.number, [PROMOTE_LEVEL_LABEL]).then(() => '', (e) => `the ${PROMOTE_LEVEL_LABEL} label couldn't be added: ${e.message.slice(0, 300)}`);
        return { pr: { url: opened.url, number: opened.number }, detail: labelled };
    }
}
//# sourceMappingURL=learnings.js.map