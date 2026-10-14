// WHY: setup mode's own panels (src/setup-mode.ts): pick the repo, answer auto-config's questions, draft the config
// (it runs the project's commands, so it is confirmed first), and merge the setup PR it opened. Each change is shown
// before it is made and done by the server for the owners only.
import { useEffect, useState } from 'react';
import { getSetupRepos, setupAnswers, setupDraft, setupMerge, setupOrigin, type DraftJob, type FirstRunAutoConfig } from '../api';
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

export function SetupAutoConfig({ a: ac, draft, canEdit, onDone, initialConfirming = false }: { a: FirstRunAutoConfig | null; draft: DraftJob | undefined; canEdit: boolean; onDone: () => void; initialConfirming?: boolean }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(initialConfirming);
  const [merge, setMerge] = useState<string | null>(null);
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
      {!questions.length && !ac?.pr && canEdit && (
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
      {ac?.pr && (
        <div className="space-y-2" data-testid="setup-pr">
          <p className="text-[12.5px] text-ink-2">
            Proposed as{' '}
            <a href={ac.pr.url} target="_blank" rel="noreferrer" className="text-blue-ink hover:underline">
              {ac.pr.number ? `PR #${ac.pr.number}` : 'a PR'}
            </a>
            . Review it on GitHub; merging it puts the config on the default branch, and this checkout fast-forwards to it.
          </p>
          {canEdit && !merge && (
            <Button size="sm" variant="outline" disabled={act.busy || running} onClick={() => void act.run(async () => void setMerge((await setupMerge(false)).command ?? ''))} data-testid="setup-merge-review">
              Merge…
            </Button>
          )}
          {merge && (
            <div className="space-y-2 rounded-lg bg-blue-tint p-3" data-testid="setup-merge-confirming">
              <code className={code}>{merge}</code>
              <div className="flex gap-2">
                <Button size="sm" disabled={act.busy} onClick={() => void act.run(async () => (await setupMerge(true), setMerge(null), onDone(), 'merged: bringing the config into this checkout'))} data-testid="setup-merge-confirm">
                  Confirm merge
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setMerge(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
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
