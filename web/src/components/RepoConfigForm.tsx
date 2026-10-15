// WHY: the repo's config changes only through a reviewed commit, so this form never writes it: Review asks the
// server what the values change on the default branch, and Propose opens that change as a PR. Merge (an owner, after
// seeing the command) merges that PR and fast-forwards this checkout to it, so the next step reads the new config.
import { useEffect, useState } from 'react';
import { changeRepoConfig, getChecksSeen, mergeRepoConfig, type ConfigChange, type FirstRunRepoConfig, type RepoConfigValues, type StarterCi as StarterCiView } from '../api';
import { StarterCi } from './StarterCi';
import { Button, cx } from './ui';

const field = 'h-8 rounded-control bg-field px-2.5 font-mono text-[13px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--blue)] disabled:opacity-60';
const show = (v: unknown) => (Array.isArray(v) ? (v.length ? v.join(', ') : 'none') : v === undefined || v === null ? 'not set' : String(v));
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** The PR number in a GitHub PR URL. */
const prNumber = (url: string | undefined) => Number(/\/pull\/(\d+)$/.exec(url ?? '')?.[1] ?? 0) || null;

/** Merge the proposed PR from here: the command first, then Confirm; then the checkout is fast-forwarded to it. */
function MergePanel({ number, initialPlan = null, onDone }: { number: number; initialPlan?: { command: string; then: string } | null; onDone?: () => void }) {
  const [plan, setPlan] = useState<{ command: string; then: string } | null>(initialPlan);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const go = async (confirm: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await mergeRepoConfig(number, confirm);
      if (!confirm) setPlan({ command: r.command ?? '', then: r.then ?? '' });
      else {
        setPlan(null);
        setMsg({ ok: !!r.synced, text: `merged PR #${r.number}; ${r.detail ?? ''}` });
        onDone?.();
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2" data-testid="repo-config-merge">
      {!plan ? (
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void go(false)} data-testid="repo-config-merge-review">
          Merge PR #{number} here…
        </Button>
      ) : (
        <div className="space-y-2 rounded-lg bg-blue-tint p-3" data-testid="repo-config-merge-confirming">
          <p className="text-[12.5px] text-ink">It runs:</p>
          <code className="block overflow-x-auto whitespace-pre rounded-lg bg-surface px-3 py-2 font-mono text-[12px] text-ink shadow-hairline">{plan.command}</code>
          <p className="text-[12.5px] text-ink-2">{plan.then}.</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={busy} onClick={() => void go(true)} data-testid="repo-config-merge-confirm">
              {busy ? 'Merging…' : 'Confirm merge'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPlan(null)} data-testid="repo-config-merge-cancel">
              Cancel
            </Button>
          </div>
        </div>
      )}
      {msg && (
        <p className={cx('break-words text-[12.5px]', msg.ok ? 'text-green' : 'text-red')} data-testid="repo-config-merge-result">
          {msg.text}
        </p>
      )}
    </div>
  );
}

/**
 * INVARIANT: nothing above an input moves once the form is on screen. The checks GitHub ran arrive after mount, so
 * they go in slots of a fixed size, reserved from the first render (data-reserved): a one-line status and a check list
 * that scrolls inside its own height. A late answer changes what is in them, never where the fields below them are.
 */
const STATUS_SLOT = 'block h-5 truncate text-[12px] leading-5 text-ink-3';
const CHECKS_SLOT = 'h-[4.75rem] overflow-y-auto rounded-lg';

export function RepoConfigForm({ c, canEdit, initialChanges = null, initialSeen = [], initialSeenNote = null, initialSeenLoaded = false, initialProposed = null, initialMergePlan = null, initialStarter = null, initialStarterOpen = false, onMerged }: { c: FirstRunRepoConfig; canEdit: boolean; initialChanges?: ConfigChange[] | null; initialSeen?: string[]; initialSeenNote?: string | null; initialSeenLoaded?: boolean; initialProposed?: string | null; initialMergePlan?: { command: string; then: string } | null; initialStarter?: StarterCiView | null; initialStarterOpen?: boolean; onMerged?: () => void }) {
  const [writers, setWriters] = useState(c.values.writers.join(', '));
  const [checks, setChecks] = useState<string[]>(c.values.required_checks);
  const [budget, setBudget] = useState(c.values.daily_budget_usd);
  const [count, setCount] = useState(c.values.workers_count);
  const [model, setModel] = useState(c.values.workers_model);
  const [ci, setCi] = useState<'github' | 'none'>(c.values.ci ?? 'github');
  const [seen, setSeen] = useState<string[]>(initialSeen);
  const [extra, setExtra] = useState('');
  const [seenNote, setSeenNote] = useState<string | null>(initialSeenNote);
  const [seenLoaded, setSeenLoaded] = useState(initialSeenLoaded);
  const [changes, setChanges] = useState<ConfigChange[] | null>(initialChanges);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; url?: string } | null>(initialProposed ? { ok: true, text: 'proposed: merge the PR to apply it', url: initialProposed } : null);
  useEffect(() => {
    getChecksSeen()
      .then((r) => (setSeen(r.checks), setSeenNote(r.error ?? (r.checks.length ? null : `GitHub ran no checks on its tip${c.values.required_checks.length ? '' : ': add a starter CI below'}`))))
      .catch((e: Error) => setSeenNote(e.message))
      .finally(() => setSeenLoaded(true));
  }, []);
  const edited = () => (setChanges(null), setMsg(null));
  const values = (): Partial<RepoConfigValues> => ({ writers: list(writers), required_checks: checks, daily_budget_usd: budget, workers_count: count, workers_model: model, ...(ci !== (c.values.ci ?? 'github') ? { ci } : {}) });
  const send = async (confirm: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await changeRepoConfig(values(), confirm);
      if (confirm) {
        setChanges(null);
        setMsg({ ok: true, text: `proposed on ${r.branch}: merge the PR to apply it (here, or on GitHub)`, ...(r.url ? { url: r.url } : {}) });
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
        Changes to {c.repo}'s config are proposed as a PR against {c.branch}; nothing changes until it merges. Owner: <span className="font-mono text-[12px]">@{c.owner}</span>.
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
              {busy ? 'Proposing…' : 'Propose as a PR'}
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
      {canEdit && msg?.ok && prNumber(msg.url) && <MergePanel number={prNumber(msg.url)!} initialPlan={initialMergePlan} {...(onMerged ? { onDone: onMerged } : {})} />}
      {/* #469: no checks chosen yet. Last in the form, so a late answer moves nothing above it. */}
      {!c.values.required_checks.length && c.values.ci !== 'none' && <StarterCi canEdit={canEdit} initialView={initialStarter} initialOpen={initialStarterOpen} noCiChosen={ci === 'none'} onCheckRan={(name) => !checks.includes(name) && (setChecks((now) => (now.includes(name) ? now : [...now, name])), edited())} onChooseNoCi={() => (setCi('none'), setChecks([]), edited())} />}
    </div>
  );
}
