// The Machine page's Updates panel (GET /api/updates, src/updates.ts updatesPanel): the engine the machine runs now,
// the last install, any rollback or held commit with its reason, and the canary's last result: passed or failed,
// how long it took, a link to its PR (docs/canary.md). The full log stays in the Engine updates table below.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { ago, Badge, Card } from './ui';

export interface UpdatesPanelData {
  configured: boolean;
  enabled: boolean | null;
  installed: { sha: string | null; version: string | null };
  lastInstall: { at: string; from: string | null; to: string | null } | null;
  rollback: { at: string; sha: string | null; reason: string; held: boolean; canary: boolean } | null;
  canary: {
    settings: { instance: string; repo: string; timeLimitMinutes: number } | null;
    running: { at: string; trigger: 'update' | 'daily'; issue: number | null; url: string | null; deadline: string | null } | null;
    last: {
      at: string;
      passed: boolean;
      trigger: 'update' | 'daily';
      stage: string | null;
      why: string | null;
      durationMs: number | null;
      timedOut: boolean;
      issue: { number: number; url: string | null } | null;
      pr: { number: number; url: string } | null;
      sha: string | null;
    } | null;
  };
}

const short = (s: string | null | undefined) => (s ? s.slice(0, 12) : '–');
const when = (ts: string) => `${new Date(ts).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

/** A duration as people say it: 42s, 17 min, 1 h 05 min. */
export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
}

function Row({ label, testId, children }: { label: string; testId: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 border-b border-line px-4 py-2.5 last:border-0 sm:flex-row sm:gap-4" data-testid={testId}>
      <div className="shrink-0 text-[12px] text-ink-3 sm:w-32">{label}</div>
      <div className="min-w-0 break-words text-[12.5px] text-ink-2">{children}</div>
    </div>
  );
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="text-blue-ink underline-offset-2 hover:underline">
      {children}
    </a>
  );
}

export function UpdatesPanelView({ data }: { data: UpdatesPanelData }) {
  const c = data.canary;
  const last = c.last;
  return (
    <section className="space-y-1.5" aria-label="Updates" data-testid="updates-panel">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Updates</span>
        <span className="text-[12px] text-ink-3">{!data.configured ? "the updater isn't set up on this machine" : data.enabled ? 'automatic engine updates are on' : 'automatic engine updates are off'}</span>
      </div>
      <Card className="overflow-hidden">
        <Row label="Installed" testId="updates-installed">
          {data.installed.version ? <span className="font-medium text-ink">v{data.installed.version}</span> : <span>unknown version</span>}
          {data.installed.sha ? <span className="ml-2 font-mono text-[12px] text-ink-3">{short(data.installed.sha)}</span> : null}
        </Row>
        <Row label="Last update" testId="updates-last">
          {data.lastInstall ? (
            <span title={data.lastInstall.at}>
              {ago(data.lastInstall.at)} · <span className="font-mono text-[12px]">{short(data.lastInstall.from)} → {short(data.lastInstall.to)}</span>
            </span>
          ) : (
            'no install recorded yet'
          )}
        </Row>
        <Row label="Rollback" testId="updates-rollback">
          {data.rollback ? (
            <div role="alert" className="space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="danger">{data.rollback.canary ? 'rolled back: canary failed' : 'rolled back'}</Badge>
                {data.rollback.held ? <Badge tone="warn">held</Badge> : null}
                <span className="text-[12px] text-ink-3" title={data.rollback.at}>
                  {when(data.rollback.at)}
                  {data.rollback.sha ? <span className="font-mono">, {short(data.rollback.sha)}</span> : null}
                </span>
              </div>
              <div data-testid="updates-rollback-reason">{data.rollback.reason}</div>
              {data.rollback.held ? <div className="text-[12px] text-ink-3">Every instance runs the previous engine. This commit is held until a newer one, or until an admin releases it at a root shell: <span className="font-mono">sudo bash scripts/setup/updates.sh --release-hold</span>. Turning updates off and on doesn't.</div> : null}
            </div>
          ) : (
            'none'
          )}
        </Row>
        <Row label="Canary" testId="updates-canary">
          {!c.settings ? (
            <span>
              not set up: see <span className="font-mono text-[12px]">docs/canary.md</span>
            </span>
          ) : (
            <div className="space-y-1">
              <div className="text-[12px] text-ink-3">
                instance <span className="font-mono">{c.settings.instance}</span> on <span className="font-mono">{c.settings.repo}</span>, time limit {c.settings.timeLimitMinutes} min
              </div>
              {last ? (
                <div className="flex flex-wrap items-center gap-1.5" data-testid="updates-canary-last">
                  <Badge tone={last.passed ? 'ok' : 'danger'}>{last.passed ? 'passed' : last.timedOut ? 'timed out' : 'failed'}</Badge>
                  <span>
                    {last.trigger === 'update' ? `after installing ${short(last.sha)}` : 'daily'} · {duration(last.durationMs)} · <span title={last.at}>{ago(last.at)}</span>
                  </span>
                  {last.pr ? (
                    <Link href={last.pr.url}>PR #{last.pr.number}</Link>
                  ) : last.issue?.url ? (
                    <Link href={last.issue.url}>issue #{last.issue.number}</Link>
                  ) : null}
                </div>
              ) : (
                <div>no result yet</div>
              )}
              {last && !last.passed && last.why ? <div className="text-[12px] text-red" data-testid="updates-canary-why">{last.why}</div> : null}
              {c.running ? (
                <div className="text-[12px] text-ink-3" data-testid="updates-canary-running">
                  running now ({c.running.trigger === 'update' ? 'after an update' : 'daily'}): filed {ago(c.running.at)}
                  {c.running.url ? (
                    <>
                      {' '}
                      as <Link href={c.running.url}>issue #{c.running.issue}</Link>
                    </>
                  ) : null}
                  {c.running.deadline ? `, time limit ${when(c.running.deadline)}` : ''}
                </div>
              ) : null}
            </div>
          )}
        </Row>
      </Card>
    </section>
  );
}

export function UpdatesPanel() {
  const [data, setData] = useState<UpdatesPanelData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<UpdatesPanelData>('/api/updates')
      .then((d) => (setData(d), setError(null)))
      .catch((e: Error) => setError(e.message));
  }, []);
  if (error) return <div className="text-[13px] text-red" data-testid="updates-panel">Can't load engine updates: {error}</div>;
  if (!data) return null;
  return <UpdatesPanelView data={data} />;
}
