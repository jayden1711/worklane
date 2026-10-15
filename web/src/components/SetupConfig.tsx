// WHY: setup mode's own panels (src/setup-mode.ts): pick the repo, answer auto-config's questions, draft the config
// (it runs the project's commands, so it is confirmed first), preview the draft and Confirm it as the setup PR (#468),
// which the Config PRs list then follows to its merge. Each change is shown before it is made and done by the server
// for the owners only.
import { useEffect, useState } from 'react';
import { getSetupRepos, setupAnswers, setupDraft, setupDraftValues, setupOrigin, setupPropose, type DraftJob, type FirstRunAutoConfig, type HeldDraftView } from '../api';
import { RepoConfigForm } from './RepoConfigForm';
import { Button, cx } from './ui';

const field = 'h-8 rounded-control bg-field px-2.5 font-mono text-[13px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--blue)] disabled:opacity-60';
const code = 'block overflow-x-auto whitespace-pre rounded-lg bg-surface px-3 py-2 font-mono text-[12px] text-ink shadow-hairline';

function useAct() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (f: () => Promise<string | void>) => {
    setBusy(true);
    setMsg(null);
    try {
      const t = await f();
      if (t) setMsg({ ok: true, text: t });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const note = msg && (
    <p className={cx('break-words text-[12.5px]', msg.ok ? 'text-green' : 'text-red')} data-testid="setup-result">
      {msg.text}
    </p>
  );
  return { busy, run, note };
}

export function SetupOrigin({ canEdit, initialRepos = [], onDone }: { canEdit: boolean; initialRepos?: string[]; onDone: () => void }) {
  const [repos, setRepos] = useState<string[]>(initialRepos);
  const [note, setNote] = useState<string | null>(null);
  const [repo, setRepo] = useState('');
  const [commands, setCommands] = useState<string[] | null>(null);
  const a = useAct();
  useEffect(() => {
    getSetupRepos()
      .then((r) => (setRepos(r.repos), setNote(r.error ?? null)))
      .catch((e: Error) => setNote(e.message));
  }, []);
  return (
    <div className="space-y-2.5" data-testid="setup-origin">
      <p className="text-[12.5px] text-ink-2">The GitHub repo this checkout works on: one you can push to. Its origin is set to it and fetched; no files change.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input list="setup-repos" value={repo} disabled={!canEdit || a.busy} onChange={(e) => (setRepo(e.target.value.trim()), setCommands(null))} placeholder="owner/name" className={cx(field, 'w-72')} spellCheck={false} data-testid="setup-origin-repo" />
        <datalist id="setup-repos">
          {repos.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        {canEdit && !commands && (
          <Button size="sm" variant="outline" disabled={a.busy || !repo} onClick={() => void a.run(async () => void setCommands((await setupOrigin(repo, false)).commands ?? []))} data-testid="setup-origin-review">
            Review
          </Button>
        )}
      </div>
      {note && <p className="text-[12px] text-ink-3">{note}</p>}
      {commands && (
        <div className="space-y-2 rounded-lg bg-blue-tint p-3" data-testid="setup-origin-confirming">
          <code className={code}>{commands.join('\n')}</code>
          <div className="flex gap-2">
            <Button size="sm" disabled={a.busy} onClick={() => void a.run(async () => (await setupOrigin(repo, true), setCommands(null), onDone(), `origin is github.com/${repo}`))} data-testid="setup-origin-confirm">
              Confirm
            </Button>
            <Button size="sm" variant="ghost" disabled={a.busy} onClick={() => setCommands(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {!canEdit && <p className="text-[12.5px] text-ink-3">Only the owners can set this checkout up.</p>}
      {a.note}
    </div>
  );
}

export function SetupAutoConfig({ a: ac, draft, canEdit, onDone, initialConfirming = false, initialChanging = false }: { a: (FirstRunAutoConfig & { repo?: string | null }) | null; draft: DraftJob | undefined; canEdit: boolean; onDone: () => void; initialConfirming?: boolean; initialChanging?: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(initialConfirming);
  const act = useAct();
  const questions = ac?.questions ?? [];
  const running = !!draft?.running;
  const given = () => Object.fromEntries(Object.entries(answers).map(([id, c]) => [id, c === 'custom' ? `custom:${custom[id] ?? ''}` : c]));
  return (
    <div className="space-y-3" data-testid="setup-config">
      {!!questions.length && (
        <div className="space-y-3" data-testid="setup-questions">
          <p className="text-[12.5px] text-ink-2">Nothing is guessed: answer these, then draft the config again.</p>
          {questions.map((q) => (
            <fieldset key={q.id} className="space-y-1.5" data-testid="setup-question" data-question={q.id}>
              <legend className="break-words text-[13px] text-ink">{q.ask}</legend>
              {q.choices.map((c) => (
                <label key={c.id} className="flex min-w-0 items-start gap-2 text-[12.5px] text-ink-2">
                  <input type="radio" name={`q-${q.id}`} value={c.id} checked={answers[q.id] === c.id} disabled={!canEdit || act.busy} onChange={() => setAnswers({ ...answers, [q.id]: c.id })} className="mt-0.5" data-testid="setup-choice" />
                  <span className="min-w-0 break-words">{c.label}</span>
                </label>
              ))}
              {answers[q.id] === 'custom' && <input value={custom[q.id] ?? ''} disabled={!canEdit || act.busy} onChange={(e) => setCustom({ ...custom, [q.id]: e.target.value })} placeholder="the command" className={cx(field, 'w-full')} spellCheck={false} data-testid="setup-custom" />}
            </fieldset>
          ))}
          {canEdit && (
            <Button size="sm" variant="outline" disabled={act.busy || !Object.keys(answers).length} onClick={() => void act.run(async () => (await setupAnswers(given()), setAnswers({}), onDone(), 'answers saved: draft the config to go on'))} data-testid="setup-save-answers">
              Save the answers
            </Button>
          )}
        </div>
      )}
      {!questions.length && !ac?.pr && !ac?.held && canEdit && (
        <div className="space-y-2" data-testid="setup-draft">
          <p className="text-[12.5px] text-ink-2">Draft finds your project's commands, runs each on a scratch copy of the default branch (as you, in a worktree beside this checkout), asks what it can't settle, and proposes the config as a PR from its own branch. This checkout isn't changed.</p>
          {!confirming ? (
            <Button size="sm" disabled={running || act.busy} onClick={() => setConfirming(true)} data-testid="setup-draft-button">
              {running ? 'Drafting…' : 'Draft the config…'}
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-blue-tint p-3" data-testid="setup-draft-confirming">
              <span className="text-[12.5px] text-ink">Run your project's commands to draft it?</span>
              <Button size="sm" disabled={act.busy} onClick={() => void act.run(async () => (await setupDraft(), setConfirming(false), onDone()))} data-testid="setup-draft-confirm">
                Confirm
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
      {ac?.held && !ac.pr && <DraftPreview held={ac.held} repo={ac.repo ?? null} canEdit={canEdit} running={running} onDone={onDone} initialChanging={initialChanging} />}
      {ac?.pr && (
        <p className="text-[12.5px] text-ink-2" data-testid="setup-pr">
          Proposed as{' '}
          <a href={ac.pr.url} target="_blank" rel="noreferrer" className="text-blue-ink hover:underline">
            {ac.pr.number ? `PR #${ac.pr.number}` : 'a PR'}
          </a>
          : merge it under Config PRs below, or on GitHub. Either way this page notices, brings the config into this checkout, and goes on here.
        </p>
      )}
      {draft && (draft.running || draft.lines.length > 0) && (
        <div className="space-y-1" data-testid="setup-draft-log">
          <div className="text-[12px] text-ink-3">{draft.running ? 'Running…' : `Finished${draft.result ? `: ${draft.result.detail}` : ''}`}</div>
          <code className={cx(code, 'max-h-56 overflow-y-auto')}>{draft.lines.slice(-40).join('\n')}</code>
        </div>
      )}
      {!canEdit && <p className="text-[12.5px] text-ink-3">Only the owners can set this checkout up.</p>}
      {act.note}
    </div>
  );
}

/**
 * WHY (#468): the drafted config before any PR: first what it means in plain words (from the drafted files themselves),
 * then the files, read-only. Confirm opens the setup PR (and, for the repo's admin, merges it as their approval when
 * GitHub allows it); Change opens the Repo config form on the draft, keeping what was changed.
 */
export function DraftPreview({ held, repo, canEdit, running, onDone, initialChanging = false }: { held: HeldDraftView; repo: string | null; canEdit: boolean; running: boolean; onDone: () => void; initialChanging?: boolean }) {
  const [changing, setChanging] = useState(initialChanging);
  const act = useAct();
  const s = held.summary;
  if (changing && held.values && s)
    return (
      <div className="space-y-2" data-testid="draft-change">
        <RepoConfigForm c={{ values: held.values, owner: s.owner, branch: 'the default branch', repo: repo ?? 'this repo' }} canEdit={canEdit} draft={{ save: async (values, confirm) => (await setupDraftValues(values, confirm)).changes, onSaved: () => (setChanging(false), onDone()), onCancel: () => setChanging(false) }} />
      </div>
    );
  const row = (testid: string, label: string, value: React.ReactNode) => (
    <div className="grid grid-cols-[9rem_1fr] gap-2 py-1 max-sm:grid-cols-1 max-sm:gap-0.5" data-testid={testid}>
      <dt className="text-[12px] text-ink-3">{label}</dt>
      <dd className="min-w-0 break-words text-[12.5px] text-ink">{value}</dd>
    </div>
  );
  return (
    <div className="space-y-3" data-testid="draft-preview">
      <p className="text-[12.5px] text-ink-2">The drafted config, before any PR. Nothing is pushed until you Confirm it.</p>
      {s ? (
        <dl className="divide-y divide-line rounded-lg bg-surface px-3 shadow-hairline" data-testid="draft-summary">
          {row('draft-summary-owners', 'Owners and writers', <>owner @{s.owner}; writers {s.writers.map((w) => `@${w}`).join(', ') || 'none'}</>)}
          {row(
            'draft-summary-tests',
            'Tests',
            s.tests.length ? (
              <ul className="space-y-0.5">
                {s.tests.map((t) => (
                  <li key={t.slot}>
                    <span className="text-ink-3">{t.slot}: </span>
                    <code className="font-mono text-[12px]">{t.command}</code>
                  </li>
                ))}
              </ul>
            ) : (
              'none'
            ),
          )}
          {row('draft-summary-budget', 'Daily budget', `$${s.dailyBudgetUsd}`)}
          {row('draft-summary-models', 'Models', s.models.map((m) => `${m.role}: ${m.model}`).join(', ') || 'none')}
          {row(
            'draft-summary-waits',
            'Waits for you',
            <ul className="list-disc space-y-0.5 pl-4">
              {s.waits.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>,
          )}
          {row('draft-summary-automerge', 'May merge itself', s.autoMerge)}
        </dl>
      ) : (
        <p className="break-words text-[12.5px] text-red" data-testid="draft-error">
          The draft doesn't load: {held.error}
        </p>
      )}
      <div className="space-y-1" data-testid="draft-files">
        {held.files.map((f) => (
          <details key={f.name} className="rounded-lg bg-surface shadow-hairline" data-testid="draft-file" data-file={f.name}>
            <summary className="cursor-pointer select-none px-3 py-1.5 font-mono text-[12px] text-ink">{f.name}</summary>
            <pre className="max-h-72 overflow-auto border-t border-line px-3 py-2 font-mono text-[11.5px] text-ink-2">{f.text}</pre>
          </details>
        ))}
      </div>
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={act.busy || running || !s} onClick={() => void act.run(async () => {
            const r = await setupPropose();
            onDone();
            return r.merged ? (r.detail ?? `PR #${r.number} merged as your approval`) : (r.why ?? `PR #${r.number} opened: merge it on GitHub`);
          })} data-testid="draft-confirm">
            {act.busy ? 'Proposing…' : 'Confirm'}
          </Button>
          <Button size="sm" variant="outline" disabled={act.busy || !s} onClick={() => setChanging(true)} data-testid="draft-change-button">
            Change
          </Button>
          <span className="text-[12px] text-ink-3">Confirm opens the setup PR; if you're the repo's admin and GitHub allows it, it merges it here as your approval.</span>
        </div>
      ) : (
        <p className="text-[12.5px] text-ink-3">Only the owners can set this checkout up.</p>
      )}
      {act.note}
    </div>
  );
}
