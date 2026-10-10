import { api, useFetch, type PrView, type PrsView, type State } from '../api';
import { navigate } from '../App';
import { DotPill, Loading, RecordsTable, StatusMark, TaskRow, type MarkState } from '../components/patterns';
import { ago, Badge, Card, cx, Empty } from '../components/ui';
import { Header } from './Overview';

const OUTCOME_DOT: Record<string, 'green' | 'red' | 'orange' | 'ink'> = { pass: 'green', fail: 'red', cancelled: 'red', pending: 'orange', missing: 'orange', skipped: 'ink' };
const PHASE: Record<PrView['phase'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral'; mark: MarkState }> = {
  waiting: { label: 'waiting for you', tone: 'warn', mark: 'waiting' },
  gave_up: { label: 'CI fix gave up', tone: 'danger', mark: 'failed' },
  fixing: { label: 'fixing CI', tone: 'info', mark: 'running' },
  checks: { label: 'draft: checks', tone: 'neutral', mark: 'running' },
  ready: { label: 'ready', tone: 'ok', mark: 'done' },
  auto_merged: { label: 'auto-merged', tone: 'ok', mark: 'done' },
  merged: { label: 'merged', tone: 'ok', mark: 'done' },
  closed: { label: 'closed', tone: 'neutral', mark: 'skipped' },
};

const short = (sha: string) => sha.slice(0, 8);
const ext = { target: '_blank', rel: 'noreferrer' } as const;

function PrLink({ pr }: { pr: PrView }) {
  return (
    <a href={pr.url} {...ext} className="font-mono text-blue-ink hover:underline" onClick={(e) => e.stopPropagation()}>
      #{pr.number}
    </a>
  );
}

/** Each required check on the PR's current head, as dot pills. */
function Checks({ pr }: { pr: PrView }) {
  const checks = pr.status?.head === pr.head ? pr.status.checks : [];
  if (!checks.length) return <span className="text-[12px] text-ink-3">no check results on {short(pr.head)} yet</span>;
  return (
    <span className="flex flex-wrap gap-1.5" data-pr-checks={pr.number}>
      {checks.map((c) => (
        <DotPill key={c.name} tone={OUTCOME_DOT[c.outcome] ?? 'ink'}>
          {c.name}: {c.outcome}
        </DotPill>
      ))}
    </span>
  );
}

function checkSummary(pr: PrView): string {
  const checks = pr.status?.head === pr.head ? pr.status.checks : [];
  if (!checks.length) return 'checks not in yet';
  return `${checks.filter((c) => c.outcome === 'pass').length}/${checks.length} required checks pass`;
}

/** A PR waiting for a person, as a recommendation-style card: what it is, exactly why it waits, its checks, and where to act. */
function WaitingCard({ pr }: { pr: PrView }) {
  const reasons = pr.phase === 'gave_up' ? [pr.gaveUp!.reason] : (pr.decision?.reasons ?? []);
  return (
    <div className="overflow-hidden rounded-card bg-surface shadow-card" data-pr={pr.number} data-phase={pr.phase} style={{ animation: 'fade-up 380ms cubic-bezier(0.23,1,0.32,1) both' }}>
      <div className="primitive-card-pad">
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-ink-3">
          <PrLink pr={pr} />
          <button className="font-mono hover:underline" onClick={() => navigate(`/issues/${pr.issue}`)}>
            issue #{pr.issue}
          </button>
          <Badge tone={PHASE[pr.phase].tone}>{PHASE[pr.phase].label}</Badge>
          <span>· {pr.draft ? 'draft' : 'ready for review'}</span>
          <span>· opened {ago(pr.openedAt)}</span>
        </div>
        <div className="mt-2 text-[14px] font-medium text-ink">{pr.title}</div>
        <div className="mt-1.5 text-[12px] font-medium text-ink-3">{pr.phase === 'gave_up' ? 'Why the CI fix stopped' : 'Why it waits for you'}</div>
        <ul className="mt-1 space-y-1 rounded-control bg-inset px-2.5 py-2 text-[12.5px] text-ink shadow-hairline" data-pr-reasons={pr.number}>
          {reasons.length ? reasons.map((r, i) => <li key={i}>{r}</li>) : <li className="text-ink-3">no reason recorded</li>}
        </ul>
        <div className="mt-2.5">
          <Checks pr={pr} />
        </div>
      </div>
      <div className="primitive-card-footer flex items-center gap-2 border-t border-line text-[12px] text-ink-3">
        <span>
          head <span className="font-mono">{short(pr.head)}</span>
          {pr.fixes.length ? ` · ${pr.fixes.length} fix run(s)` : ''}
        </span>
        <a href={pr.url} {...ext} className="ml-auto inline-flex h-7 items-center rounded-full bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90">
          Review on GitHub
        </a>
      </div>
    </div>
  );
}

/** The fix runs on a PR, newest last. */
function Fixes({ pr }: { pr: PrView }) {
  if (!pr.fixes.length) return <div className="text-[12px] text-ink-3">no fix runs</div>;
  return (
    <ul className="space-y-1 text-[12px]">
      {pr.fixes.map((f) => (
        <li key={f.attempt} className="flex items-center gap-2">
          <Badge tone={f.outcome === 'pushed' ? 'ok' : f.outcome === 'running' ? 'info' : 'danger'}>
            fix {f.attempt}: {f.outcome}
          </Badge>
          <span className="truncate text-ink-2">{f.detail || f.checks.join(', ')}</span>
          <span className="ml-auto shrink-0 text-ink-3">{ago(f.at)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The whole PR view from its data (also what the render checks render). */
export function PullRequestsView({ view }: { view: PrsView }) {
  const by = (...phases: PrView['phase'][]) => view.prs.filter((p) => phases.includes(p.phase));
  const waiting = by('waiting', 'gave_up');
  const moving = by('fixing', 'checks', 'ready');
  const auto = by('auto_merged');
  const done = by('merged', 'closed');
  const am = view.autoMerge;
  const lastStop = view.stops.find((s) => s.kind === 'stopped');
  return (
    <div className="space-y-6 p-6">
      <div className="overflow-hidden rounded-card bg-surface shadow-card" data-auto-merge={am.on ? 'on' : am.stopped ? 'stopped' : 'off'}>
        <div className="primitive-card-pad">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-medium text-ink">Auto-merge on this instance</span>
            <Badge tone={am.on ? 'ok' : am.stopped ? 'danger' : 'neutral'}>{am.on ? 'on' : am.stopped ? 'stopped' : 'off'}</Badge>
          </div>
          <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{am.why}</p>
        </div>
        <div className="primitive-card-footer flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line text-[12px] text-ink-3">
          <span>
            policy kill switch: <span className="text-ink">{am.policy === null ? 'n/a' : am.policy ? 'on' : 'off'}</span>
          </span>
          <span>
            repo review.yaml: <span className="text-ink">{am.repo === null ? 'n/a' : am.repo ? 'on' : 'off'}</span>
          </span>
          {lastStop && (
            <span>
              last stop {ago(lastStop.at)}: {lastStop.reason}
              {lastStop.revert && (
                <>
                  {' '}
                  ·{' '}
                  <a href={lastStop.revert} {...ext} className="text-blue-ink hover:underline">
                    revert PR
                  </a>
                </>
              )}
            </span>
          )}
        </div>
      </div>

      <section className="space-y-2" aria-label="Waiting for you">
        <div className="text-[13px] font-medium text-ink">Waiting for you ({waiting.length})</div>
        {waiting.length ? <div className="space-y-3">{waiting.map((pr) => <WaitingCard key={pr.number} pr={pr} />)}</div> : <Empty title="Nothing waits for you" hint="A PR lands here when the merge rules leave it to you, or a CI fix run gives up." />}
      </section>

      <Card className="overflow-hidden">
        <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">In progress ({moving.length})</div>
        {moving.length ? (
          moving.map((pr, i) => (
            <TaskRow
              key={pr.number}
              index={i}
              testId={`pr-${pr.number}`}
              mark={<StatusMark state={PHASE[pr.phase].mark} />}
              label={
                <>
                  {pr.title} <span className="font-normal text-ink-3">· #{pr.number}</span>
                </>
              }
              amount={checkSummary(pr)}
              pill={<Badge tone={PHASE[pr.phase].tone}>{PHASE[pr.phase].label}</Badge>}
              details={
                <div className="space-y-2 py-1">
                  <Checks pr={pr} />
                  {pr.status && !pr.status.ready && pr.status.reasons.length > 0 && <div className="text-[12px] text-ink-2">not ready: {pr.status.reasons.join('; ')}</div>}
                  <Fixes pr={pr} />
                  <a href={pr.url} {...ext} className="text-[12px] text-blue-ink hover:underline">
                    open on GitHub
                  </a>
                </div>
              }
            />
          ))
        ) : (
          <div className="p-4 text-[13px] text-ink-3">No open PRs being checked or fixed.</div>
        )}
      </Card>

      <section className="space-y-2" aria-label="Auto-merged">
        <div className="text-[13px] font-medium text-ink">Auto-merged ({auto.length})</div>
        {auto.length ? (
          <RecordsTable head={['PR', 'Merge commit', 'Main after', 'Why it merged itself']} className="[&_th:nth-child(1)]:w-[34%] [&_th:nth-child(2)]:w-28 [&_th:nth-child(3)]:w-28">
            {auto.map((pr) => (
              <tr key={pr.number} className="border-b border-line last:border-0" data-pr={pr.number} data-phase={pr.phase} style={{ background: pr.mainResult?.outcome === 'red' ? 'var(--red-tint)' : undefined }}>
                <td className="primitive-table-cell text-[13px]">
                  <PrLink pr={pr} /> <span className="text-ink">{pr.title}</span>
                  <div className="text-[11.5px] text-ink-3">{pr.merged ? ago(pr.merged.at) : ''}</div>
                </td>
                <td className="primitive-table-cell font-mono text-[12px]">
                  {pr.merged?.sha ? (
                    <a href={pr.merged.url} {...ext} className="text-blue-ink hover:underline">
                      {short(pr.merged.sha)}
                    </a>
                  ) : (
                    '-'
                  )}
                </td>
                <td className="primitive-table-cell">{pr.mainResult ? <DotPill tone={pr.mainResult.outcome === 'green' ? 'green' : 'red'}>{pr.mainResult.outcome}</DotPill> : <DotPill tone="orange">pending</DotPill>}</td>
                <td className="primitive-table-cell text-[12px] text-ink-2">{(pr.decision?.auto ? pr.decision.reasons : []).join('; ') || 'all merge rules passed'}</td>
              </tr>
            ))}
          </RecordsTable>
        ) : (
          <Card className="p-4 text-[13px] text-ink-3">Nothing auto-merged yet.</Card>
        )}
      </section>

      {done.length > 0 && (
        <Card className="overflow-hidden">
          <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Merged by a person, or closed ({done.length})</div>
          {done.map((pr, i) => (
            <TaskRow
              key={pr.number}
              index={i}
              testId={`pr-${pr.number}`}
              mark={<StatusMark state={PHASE[pr.phase].mark} />}
              label={
                <>
                  {pr.title} <span className="font-normal text-ink-3">· #{pr.number}</span>
                </>
              }
              amount={pr.merged ? `merged ${ago(pr.merged.at)}` : 'closed unmerged'}
              pill={<Badge tone={PHASE[pr.phase].tone}>{PHASE[pr.phase].label}</Badge>}
              details={
                <a href={pr.url} {...ext} className="text-[12px] text-blue-ink hover:underline">
                  open on GitHub
                </a>
              }
            />
          ))}
        </Card>
      )}

      {view.refused.length > 0 && (
        <section className="space-y-2" aria-label="Refused pushes">
          <div className="text-[13px] font-medium text-ink">Pushes the harness refused ({view.refused.length})</div>
          <RecordsTable head={['Issue', 'Stage', 'Why']} className="[&_th:nth-child(1)]:w-[34%] [&_th:nth-child(2)]:w-24">
            {view.refused.map((r, i) => (
              <tr key={i} className={cx('border-b border-line last:border-0')} data-refused={r.issue}>
                <td className="primitive-table-cell text-[13px]">
                  <button className="font-mono text-blue-ink hover:underline" onClick={() => navigate(`/issues/${r.issue}`)}>
                    #{r.issue}
                  </button>{' '}
                  <span className="text-ink">{r.title}</span>
                  <div className="text-[11.5px] text-ink-3">{ago(r.at)}</div>
                </td>
                <td className="primitive-table-cell text-[12px] text-ink-2">{r.stage}</td>
                <td className="primitive-table-cell text-[12px] text-red">{r.reasons.join('; ')}</td>
              </tr>
            ))}
          </RecordsTable>
        </section>
      )}
    </div>
  );
}

export function PullRequests({ state }: { state: State }) {
  const { data, error } = useFetch(() => api<PrsView>('/api/prs'), state.lastId);
  const c = state.prCounts;
  return (
    <div>
      <Header title="Pull requests" sub={c ? `${c.open} open · ${c.needYou} need you` : undefined} />
      {error ? <div className="p-8 text-[13px] text-red">Can't load pull requests: {error}</div> : data ? <PullRequestsView view={data} /> : <Loading />}
    </div>
  );
}
