// WHY: the repo's config changes only through a reviewed commit, so this form never writes it: Review asks the
// server what the values change on the default branch, and Propose opens that change as a PR. The PR is then followed
// like every config PR (web/src/components/ConfigPr.tsx, #468): merged here or anywhere, this checkout is brought to it.
// In setup mode the same form changes the held draft instead (the preview's Change), and nothing is pushed.
import { useEffect, useState } from 'react';
import { changeRepoConfig, getChecksSeen, type ConfigChange, type FirstRunRepoConfig, type RepoConfigValues } from '../api';
import { Button, cx } from './ui';

const field = 'h-8 rounded-control bg-field px-2.5 font-mono text-[13px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--blue)] disabled:opacity-60';
const show = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : v === undefined || v === null ? 'not set' : String(v));
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/**
 * INVARIANT: nothing above an input moves once the form is on screen. The checks GitHub ran arrive after mount, so
 * they go in slots of a fixed size, reserved from the first render (data-reserved): a one-line status and a check list
 * that scrolls inside its own height. A late answer changes what is in them, never where the fields below them are.
 */
const STATUS_SLOT = 'block h-5 truncate text-[12px] leading-5 text-ink-3';
const CHECKS_SLOT = 'h-[4.75rem] overflow-y-auto rounded-lg';

/** Setup mode's preview (#468): the form edits the held draft; Save keeps the values in it, Cancel goes back. */
export interface DraftTarget {
  save: (values: Partial<RepoConfigValues>, confirm: boolean) => Promise<ConfigChange[]>;
  onSaved: () => void;
  onCancel: () => void;
}

export function RepoConfigForm({ c, canEdit, initialChanges = null, initialSeen = [], initialSeenNote = null, initialSeenLoaded = false, initialProposed = null, onChanged, draft }: { c: FirstRunRepoConfig; canEdit: boolean; initialChanges?: ConfigChange[] | null; initialSeen?: string[]; initialSeenNote?: string | null; initialSeenLoaded?: boolean; initialProposed?: string | null; onChanged?: () => void; draft?: DraftTarget }) {
  const [writers, setWriters] = useState(c.values.writers.join(', '));
  const [checks, setChecks] = useState<string[]>(c.values.required_checks);
  const [budget, setBudget] = useState(c.values.daily_budget_usd);
  const [count, setCount] = useState(c.values.workers_count);
  const [model, setModel] = useState(c.values.workers_model);
  const [seen, setSeen] = useState<string[]>(initialSeen);
  const [extra, setExtra] = useState('');
  const [seenNote, setSeenNote] = useState<string | null>(initialSeenNote);
  const [seenLoaded, setSeenLoaded] = useState(initialSeenLoaded);
  const [changes, setChanges] = useState<ConfigChange[] | null>(initialChanges);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(initialProposed ? { ok: true, text: 'proposed: merge the PR to apply it', url: initialProposed } : null);
  useEffect(() => {
    getChecksSeen()
      .then((r) => (setSeen(r.checks), setSeenNote(r.error ?? (r.checks.length ? null : 'GitHub ran no checks on its tip'))))
      .catch((e: Error) => setSeenNote(e.message))
      .finally(() => setSeenLoaded(true));
  }, []);
  const edited = () => (setChanges(null), setMsg(null));
  const values = (): Partial<RepoConfigValues> => ({ writers: list(writers), required_checks: checks, daily_budget_usd: budget, workers_count: count, workers_model: model });
  const send = async (confirm: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      if (draft) {
        const changed = await draft.save(values(), confirm);
        if (!confirm) return setChanges(changed);
        setChanges(null);
        return draft.onSaved();
      }
      const r = await changeRepoConfig(values(), confirm);
      if (confirm) {
        setChanges(null);
        setMsg({ ok: true, text: `proposed on ${r.branch}: merge it under Config PRs below, or on GitHub; this page brings it into this checkout either way`, ...(r.url ? { url: r.url } : {}) });
        onChanged?.();
      } else setChanges(r.changes);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const toggle = (name: string) => (setChecks(checks.includes(name) ? checks.filter((x) => x !== name) : [...checks, name]), edited());
  const offered = [...new Set([...checks, ...seen])];
  return (
    <div className="space-y-3" data-testid="repo-config-form">
      <p className="text-[12.5px] text-ink-2">
        {draft ? (
          <>Changes to the drafted config, before it is proposed: nothing is pushed until you Confirm the preview.</>
        ) : (
          <>Changes to {c.repo}'s config are proposed as a PR against {c.branch}; nothing changes until it merges.</>
        )}{' '}
        Owner: <span className="font-mono text-[12px]">@{c.owner}</span>.
      </p>
      <label className="block space-y-1 text-[12.5px] text-ink">
        <span>Writers (GitHub logins, comma-separated; the harness works on their issues)</span>
        <input value={writers} disabled={!canEdit || busy} onChange={(e) => (setWriters(e.target.value), edited())} className={cx(field, 'w-full')} spellCheck={false} data-testid="repo-config-writers" />
      </label>
      <div className="space-y-1 text-[12.5px] text-ink" data-testid="repo-config-checks">
        <span>Required checks (a PR is marked ready once these pass)</span>
        <span className={STATUS_SLOT} data-reserved="status" data-testid="repo-config-checks-status">
          {!seenLoaded ? 'checking GitHub…' : (seenNote ?? `the checks GitHub ran on ${c.branch}'s tip are offered below`)}
        </span>
        <div className={CHECKS_SLOT} data-reserved="checks" data-testid="repo-config-check-list">
        {offered.length ? (
          <ul className="flex flex-wrap gap-1.5 p-0.5">
            {offered.map((name) => (
              <li key={name}>
                <label className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[12px] shadow-hairline', checks.includes(name) ? 'bg-blue-tint text-blue-ink' : 'bg-surface text-ink-2')} data-testid="repo-config-check" data-check={name}>
                  <input type="checkbox" checked={checks.includes(name)} disabled={!canEdit || busy} onChange={() => toggle(name)} />
                  {name}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-ink-3">none yet</p>
        )}
        </div>
        {canEdit && (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const name = extra.trim();
              if (name && !checks.includes(name)) (setChecks([...checks, name]), edited());
              setExtra('');
            }}
          >
            <input value={extra} disabled={busy} onChange={(e) => setExtra(e.target.value)} placeholder="another check, as GitHub names it" className={cx(field, 'w-64')} spellCheck={false} data-testid="repo-config-check-name" />
            <Button size="sm" variant="ghost" type="submit" disabled={busy || !extra.trim()} data-testid="repo-config-check-add">
              Add
            </Button>
          </form>
        )}
      </div>
      <div className="flex flex-wrap gap-4 text-[12.5px] text-ink">
        <label className="flex items-center gap-2">
          <span>Daily budget, $</span>
          <input type="number" min={1} step={1} value={budget} disabled={!canEdit || busy} onChange={(e) => (setBudget(Number(e.target.value)), edited())} className={cx(field, 'w-20')} data-testid="repo-config-budget" />
        </label>
        <label className="flex items-center gap-2">
          <span>Workers</span>
          <input type="number" min={0} step={1} value={count} disabled={!canEdit || busy} onChange={(e) => (setCount(Number(e.target.value)), edited())} className={cx(field, 'w-16')} data-testid="repo-config-workers-count" />
        </label>
        <label className="flex items-center gap-2">
          <span>Worker model</span>
          <input value={model} disabled={!canEdit || busy} onChange={(e) => (setModel(e.target.value), edited())} className={cx(field, 'w-32')} spellCheck={false} data-testid="repo-config-workers-model" />
        </label>
      </div>
      {!canEdit ? (
        <p className="text-[12.5px] text-ink-3" data-testid="repo-config-refused">
          Only the instance's owners can propose a config change.
        </p>
      ) : !changes ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void send(false)} data-testid="repo-config-review">
          Review the change
        </Button>
      ) : (
        <div className="space-y-2 rounded-lg bg-blue-tint p-3" data-testid="repo-config-confirming">
          <ul className="space-y-0.5">
            {changes.map((x) => (
              <li key={`${x.file} ${x.key}`} className="break-words font-mono text-[12px] text-ink" data-testid="repo-config-change">
                {x.file} {x.key}: {show(x.from)} → {show(x.to)}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void send(true)} data-testid="repo-config-propose">
              {busy ? (draft ? 'Saving…' : 'Proposing…') : draft ? 'Save to the draft' : 'Propose as a PR'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChanges(null)} data-testid="repo-config-cancel">
              Cancel
            </Button>
          </div>
        </div>
      )}
      {msg && (
        <p className={cx('break-words text-[12.5px]', msg.ok ? 'text-green' : 'text-red')} data-testid="repo-config-result">
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
      {draft && (
        <Button size="sm" variant="ghost" onClick={draft.onCancel} data-testid="repo-config-draft-back">
          Back to the preview
        </Button>
      )}
    </div>
  );
}
