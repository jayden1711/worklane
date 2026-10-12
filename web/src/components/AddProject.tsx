// Add project: the same onboarding as the CLI's `add <owner/repo>`, from the dashboard. It shows each step and
// the open asks, and answers them: a question's options, a link to open and approve, a secret to paste (sent
// once, never shown again), a root step to run through the machine helper. Only on a dashboard you run as your
// own login (the server says so: GET /api/onboard answers 404 elsewhere, and the section isn't shown).
import { useEffect, useState } from 'react';
import { api } from '../api';
import { DotPill } from './patterns';
import { Button, Card } from './ui';

export interface OnboardAsk {
  id: string;
  kind: 'paste_secret' | 'approve_link' | 'question' | 'root_step';
  title: string;
  detail: string;
  status: 'open' | 'answered' | 'cancelled';
  options?: string[];
  url?: string;
  credential?: string;
  where?: string;
  command?: string;
  args?: string[];
  allowed?: boolean;
  refusal?: string | null;
  answer: { answer: string; detail: string } | null;
}
export interface OnboardRun {
  repo: string;
  instance: string;
  running: boolean;
  result: { ok: boolean; error?: string; report: { name: string; level: 'ok' | 'warn' | 'fail'; detail: string; fix: string }[] } | null;
  steps: { id: string; title: string; status: 'done' | 'skipped' | 'failed' | 'pending'; detail: string }[];
  asks: OnboardAsk[];
}

const TONE = { done: 'green', skipped: 'ink', failed: 'red', pending: 'ink' } as const;
const field = 'h-7 rounded-control bg-field px-2 text-[12.5px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--blue)]';

function AskCard({ run, ask, onDone }: { run: OnboardRun; ask: OnboardAsk; onDone: () => void }) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const post = async (path: string, body: Record<string, unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', body: JSON.stringify({ repo: run.repo, id: ask.id, ...body }) });
      setValue('');
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-2 p-3" data-testid="onboard-ask" data-kind={ask.kind}>
      <div className="text-[13px] font-medium text-ink">{ask.title}</div>
      <div className="whitespace-pre-wrap text-[12.5px] text-ink-2">{ask.detail}</div>
      {ask.kind === 'question' && (
        <div className="flex flex-wrap gap-1.5">
          {ask.options!.map((o) => (
            <Button key={o} size="sm" variant="outline" disabled={busy} onClick={() => post('/api/onboard/answer', { answer: o })} data-testid="onboard-option">
              {o}
            </Button>
          ))}
        </div>
      )}
      {ask.kind === 'approve_link' && (
        <div className="flex flex-wrap items-center gap-1.5">
          <a href={ask.url} target="_blank" rel="noreferrer noopener" className="text-[12.5px] text-blue underline" data-testid="onboard-link">
            Open {new URL(ask.url!).host}
          </a>
          <Button size="sm" disabled={busy} onClick={() => post('/api/onboard/answer', { answer: 'approved' })}>
            Done
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => post('/api/onboard/answer', { answer: 'declined' })}>
            Decline
          </Button>
        </div>
      )}
      {ask.kind === 'paste_secret' && (
        <div className="flex flex-wrap items-center gap-1.5">
          <textarea value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" spellCheck={false} aria-label={`paste ${ask.credential}`} className={`${field} h-16 w-80 py-1 font-mono [-webkit-text-security:disc]`} data-testid="onboard-secret" />
          <Button size="sm" disabled={busy || !value} onClick={() => post('/api/onboard/secret', { value })}>
            Store
          </Button>
          <span className="text-[11.5px] text-ink-3">goes {ask.where}; never shown again</span>
        </div>
      )}
      {ask.kind === 'root_step' && (
        <div className="space-y-1.5">
          <code className="block rounded-control bg-inset px-2 py-1 font-mono text-[12px] text-ink">
            {ask.command} {ask.args!.join(' ')}
          </code>
          {ask.allowed ? (
            <div className="flex gap-1.5">
              <Button size="sm" disabled={busy} onClick={() => post('/api/onboard/run', {})} data-testid="onboard-run">
                {busy ? 'Running…' : 'Run as root (machine helper)'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => post('/api/onboard/answer', { answer: 'declined' })}>
                Decline
              </Button>
            </div>
          ) : (
            <div className="text-[12px] text-red">{ask.refusal}</div>
          )}
        </div>
      )}
      {error && <div className="text-[12px] text-red">{error}</div>}
    </Card>
  );
}

/** One onboarding: its steps, then its open asks (what the page renders; also the render check's). */
export function OnboardRunView({ run, onChanged = () => {} }: { run: OnboardRun; onChanged?: () => void }) {
  const open = run.asks.filter((a) => a.status === 'open');
  return (
    <section className="space-y-3" data-testid="onboard-run" aria-label={`Adding ${run.repo}`}>
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">{run.repo}</span>
        <span className="text-[12px] text-ink-3">instance {run.instance}{run.running ? ', running' : run.result ? (run.result.ok ? ', done' : ', stopped') : ''}</span>
      </div>
      <ol className="space-y-1" data-testid="onboard-steps">
        {run.steps.map((s) => (
          <li key={s.id} className="flex items-start gap-2 text-[12.5px]" data-testid="onboard-step" data-status={s.status}>
            <DotPill tone={TONE[s.status]}>{s.status}</DotPill>
            <span className="text-ink">{s.title}</span>
            {s.detail && <span className="min-w-0 truncate text-ink-3">{s.detail.split('\n')[0]}</span>}
          </li>
        ))}
      </ol>
      {open.map((a) => (
        <AskCard key={a.id} run={run} ask={a} onDone={onChanged} />
      ))}
      {run.result?.report.some((c) => c.level === 'fail') && (
        <Card className="space-y-1 p-3" data-testid="onboard-doctor">
          {run.result.report
            .filter((c) => c.level === 'fail')
            .map((c) => (
              <div key={c.name} className="text-[12.5px]">
                <span className="text-red">FAIL {c.name}</span>: {c.detail.split('\n')[0]}
                <div className="text-ink-3">fix: {c.fix}</div>
              </div>
            ))}
        </Card>
      )}
    </section>
  );
}

export function AddProject() {
  const [runs, setRuns] = useState<OnboardRun[] | null>(null);
  const [repo, setRepo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    api<{ runs: OnboardRun[] }>('/api/onboard')
      .then((d) => (setRuns(d.runs), setError(null)))
      .catch(() => setRuns(null));
  useEffect(() => {
    void load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);
  if (!runs) return null;
  const valid = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repo.trim());
  return (
    <section className="space-y-3" aria-label="Add project" data-testid="add-project">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[13px] font-medium text-ink">Projects</span>
        <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo" aria-label="repository to add" className={`${field} w-56`} data-testid="add-project-repo" />
        <Button
          size="sm"
          disabled={!valid}
          data-testid="add-project-button"
          onClick={async () => {
            try {
              await api('/api/onboard', { method: 'POST', body: JSON.stringify({ repo: repo.trim() }) });
              setRepo('');
              void load();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Add project
        </Button>
        {error && <span className="text-[12px] text-red">{error}</span>}
      </div>
      {runs.map((r) => (
        <OnboardRunView key={r.repo} run={r} onChanged={() => void load()} />
      ))}
    </section>
  );
}
