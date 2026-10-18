// WHY (#468): a new person's first issue had no done_when block and no ready label, and was ignored without a word.
// "Your first task" (first run, a checkout only) files one shaped as the coordinator takes it, or gives the template;
// the Issues page's "Not picked up" says, for each open issue the harness isn't working on, why, with a fix where safe.
import { useEffect, useState } from 'react';
import { addReady, fileFirstTask, getFirstTask, getIgnored, type DoneWhenPick, type FirstTaskInfo, type IgnoredIssue } from '../api';
import { Badge, Button, Card, cx } from './ui';

const field = 'h-8 rounded-control bg-field px-2.5 text-[13px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--blue)] disabled:opacity-60';
const code = 'block overflow-x-auto whitespace-pre rounded-lg bg-surface px-3 py-2 font-mono text-[12px] text-ink shadow-hairline';

type Row = { kind: 'test'; test: string } | { kind: 'command'; command: string; expect: string };

/** The template to copy: the body with its fenced done_when block, and the label to add. */
export function FirstTaskTemplate({ t }: { t: FirstTaskInfo['template'] }) {
  return (
    <details className="text-[12.5px] text-ink-2" data-testid="first-task-template">
      <summary className="cursor-pointer select-none">Or by hand: the issue body, then add the label {t.label}</summary>
      <code className={cx(code, 'mt-1.5 select-all')} data-testid="first-task-template-body">
        {t.body}
      </code>
    </details>
  );
}

export function FirstTaskForm({ canEdit, initial = null, initialPreview = null, onDone }: { canEdit: boolean; initial?: FirstTaskInfo | null; initialPreview?: { title: string; body: string } | null; onDone: () => void }) {
  const [info, setInfo] = useState<FirstTaskInfo | null>(initial);
  const [title, setTitle] = useState('');
  const [outcome, setOutcome] = useState('');
  const [context, setContext] = useState('');
  const [rows, setRows] = useState<Row[]>([{ kind: 'test', test: '' }]);
  const [preview, setPreview] = useState<{ title: string; body: string } | null>(initialPreview);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string | null } | null>(null);
  useEffect(() => {
    if (initial) return;
    getFirstTask()
      .then(setInfo)
      .catch((e: Error) => setMsg({ ok: false, text: e.message }));
  }, [initial]);
  if (info && !info.local)
    return (
      <p className="text-[12.5px] text-ink-2" data-testid="first-task-server">
        Not from here: {info.why}.
      </p>
    );
  const picks = (): DoneWhenPick[] => rows.map((r) => (r.kind === 'test' ? { test: r.test } : { command: r.command, ...(r.expect.trim() ? { expect: r.expect } : {}) }));
  const send = async (confirm: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fileFirstTask({ title, outcome, done_when: picks(), ...(context.trim() ? { context } : {}) }, confirm);
      if (!confirm) setPreview({ title: r.title, body: r.body });
      else {
        setPreview(null);
        setMsg({ ok: true, text: `filed as #${r.number}${r.labelCreated ? ' (the ready label was created)' : ''}: the coordinator picks it up within a minute; watch it on the Board`, url: r.url ?? null });
        onDone();
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const edit = (i: number, r: Row) => (setRows(rows.map((x, j) => (j === i ? r : x))), setPreview(null));
  return (
    <div className="space-y-3" data-testid="first-task-form">
      <p className="text-[12.5px] text-ink-2">The harness works on issues labelled ready whose body says when they are done: a ```done_when block of tests or commands. This files one, checked with the coordinator's own parser first.</p>
      <label className="block space-y-1 text-[12.5px] text-ink">
        <span>Title</span>
        <input value={title} disabled={!canEdit || busy} onChange={(e) => (setTitle(e.target.value), setPreview(null))} className={cx(field, 'w-full')} data-testid="first-task-title" />
      </label>
      <label className="block space-y-1 text-[12.5px] text-ink">
        <span>Outcome: what is true when it is done (one sentence)</span>
        <input value={outcome} disabled={!canEdit || busy} onChange={(e) => (setOutcome(e.target.value), setPreview(null))} className={cx(field, 'w-full')} data-testid="first-task-outcome" />
      </label>
      <div className="space-y-1.5 text-[12.5px] text-ink" data-testid="first-task-done-when">
        <span>Done when</span>
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2" data-testid="first-task-check">
            <select value={r.kind} disabled={!canEdit || busy} onChange={(e) => edit(i, e.target.value === 'test' ? { kind: 'test', test: '' } : { kind: 'command', command: '', expect: '' })} className={cx(field, 'w-28')} data-testid="first-task-check-kind">
              <option value="test">a test</option>
              <option value="command">a command</option>
            </select>
            {r.kind === 'test' ? (
              <>
                <input list="first-task-tests" value={r.test} disabled={!canEdit || busy} onChange={(e) => edit(i, { kind: 'test', test: e.target.value })} placeholder="a test file or test name" className={cx(field, 'min-w-0 flex-1 font-mono')} spellCheck={false} data-testid="first-task-test" />
              </>
            ) : (
              <>
                <input value={r.command} disabled={!canEdit || busy} onChange={(e) => edit(i, { ...r, command: e.target.value })} placeholder="a command that exits 0 when done" className={cx(field, 'min-w-0 flex-1 font-mono')} spellCheck={false} data-testid="first-task-command" />
                <input value={r.expect} disabled={!canEdit || busy} onChange={(e) => edit(i, { ...r, expect: e.target.value })} placeholder="its output holds (optional)" className={cx(field, 'w-48 font-mono')} spellCheck={false} data-testid="first-task-expect" />
              </>
            )}
            {rows.length > 1 && (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => (setRows(rows.filter((_, j) => j !== i)), setPreview(null))}>
                Remove
              </Button>
            )}
          </div>
        ))}
        <datalist id="first-task-tests">
          {(info?.tests ?? []).map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        {canEdit && rows.length < 10 && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRows([...rows, { kind: 'test', test: '' }])} data-testid="first-task-add-check">
            Add a check
          </Button>
        )}
      </div>
      <label className="block space-y-1 text-[12.5px] text-ink">
        <span>Context (optional)</span>
        <textarea value={context} disabled={!canEdit || busy} onChange={(e) => (setContext(e.target.value), setPreview(null))} rows={3} className="w-full rounded-control bg-field px-2.5 py-1.5 text-[13px] text-ink shadow-hairline outline-none" data-testid="first-task-context" />
      </label>
      {!canEdit ? (
        <p className="text-[12.5px] text-ink-3">Only the project's owners and writers can file it from here.</p>
      ) : !preview ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void send(false)} data-testid="first-task-review">
          Review the issue
        </Button>
      ) : (
        <div className="space-y-2 rounded-lg bg-blue-tint p-3" data-testid="first-task-preview">
          <div className="text-[12.5px] font-medium text-ink">{preview.title}</div>
          <code className={code}>{preview.body}</code>
          <p className="text-[12px] text-ink-2">Filed with the label ready (created if the repo has none).</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" starts disabled={busy} onClick={() => void send(true)} data-testid="first-task-file">
              {busy ? 'Filing…' : 'File it'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPreview(null)}>
              Change
            </Button>
          </div>
        </div>
      )}
      {msg && (
        <p className={cx('break-words text-[12.5px]', msg.ok ? 'text-green' : 'text-red')} data-testid="first-task-result">
          {msg.text}
          {msg.url && (
            <>
              {' '}
              <a href={msg.url} target="_blank" rel="noreferrer" className="text-blue-ink hover:underline">
                {msg.url}
              </a>
            </>
          )}
        </p>
      )}
      {info && <FirstTaskTemplate t={info.template} />}
    </div>
  );
}

const KIND_LABEL: Record<IgnoredIssue['reasons'][number]['kind'], string> = { 'no-ready': 'no ready label', contract: 'no valid done_when', 'not-writer': 'not a writer’s', waiting: 'waiting', blocked: 'blocked', held: 'held' };

/** The Issues page's "Not picked up": each open issue the harness isn't working on, and why; a writer's fix where safe. */
export function IgnoredIssues({ initial = null }: { initial?: { issues: IgnoredIssue[]; error: string | null; canFix: boolean; local: boolean } | null }) {
  const [v, setV] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const load = () =>
    getIgnored()
      .then(setV)
      .catch((e: Error) => setMsg(e.message));
  useEffect(() => {
    if (!initial) void load();
  }, [initial]);
  if (!v) return <p className="text-[12.5px] text-ink-3">{msg ?? 'Asking GitHub for the open issues…'}</p>;
  return (
    <div className="space-y-2" data-testid="issues-ignored">
      {v.error && <p className="text-[12.5px] text-orange">{v.error}</p>}
      {msg && <p className="text-[12.5px] text-red">{msg}</p>}
      {!v.issues.length ? (
        <p className="text-[12.5px] text-ink-3" data-testid="issues-ignored-none">
          Every open issue is being worked on or waits only for a free agent.
        </p>
      ) : (
        <Card className="divide-y overflow-hidden">
          {v.issues.map((i) => (
            <div key={i.issue} className="space-y-1 px-4 py-2.5" data-testid="issue-ignored" data-issue={i.issue}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-muted-foreground">#{i.issue}</span>
                <a href={i.url} target="_blank" rel="noreferrer" className="min-w-0 truncate text-[13px] text-ink hover:underline">
                  {i.title}
                </a>
              </div>
              <ul className="space-y-1">
                {i.reasons.map((r) => (
                  <li key={r.kind} className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2" data-testid="issue-ignored-reason" data-kind={r.kind}>
                    <Badge tone={r.kind === 'held' || r.kind === 'waiting' ? 'neutral' : 'warn'}>{KIND_LABEL[r.kind]}</Badge>
                    <span className="min-w-0 break-words">{r.text}</span>
                    {v.canFix && r.fix === 'add-ready' && (
                      <Button size="sm" variant="outline" starts disabled={busy === i.issue} onClick={() => {
                        setBusy(i.issue);
                        addReady(i.issue)
                          .then(load)
                          .catch((e: Error) => setMsg(e.message))
                          .finally(() => setBusy(null));
                      }} data-testid="issue-ignored-add-ready">
                        Add ready
                      </Button>
                    )}
                    {v.canFix && r.fix === 'edit' && (
                      <a href={i.url} target="_blank" rel="noreferrer" className="text-blue-ink hover:underline" data-testid="issue-ignored-edit">
                        Edit the issue
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Card>
      )}
      {!v.local && <p className="text-[12px] text-ink-3">On a server, add the label on GitHub: added from here it would be the App's, which the coordinator doesn't count as a writer's.</p>}
    </div>
  );
}
