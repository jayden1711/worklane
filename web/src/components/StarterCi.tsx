// WHY (#469): a repo with no CI has no checks to name, and an empty required_checks means no PR is ever ready. This
// drafts a starter workflow and shows it (a plain summary, then the file); Confirm opens GitHub's new-file page with
// it, where the person commits it and opens its PR as themselves. The engine never writes a workflow. Once it ran on
// the default branch, its check is selected in the form above, said so, and goes in only through Review and Propose.
import { useEffect, useState } from 'react';
import { getStarterCi, type StarterCi as View } from '../api';
import { cx } from './ui';

const btn = 'inline-flex h-7 items-center rounded-control px-2.5 text-[12.5px] font-medium';

/** GitHub's new-file page with the file in it (src/starter-ci.ts newFileUrlWith). */
const withValue = (base: string, file: string) => `${base}&value=${encodeURIComponent(file)}`;

/**
 * `inForm`: inside the Repo config form (local mode), which selects the check once it ran; outside it (a server's
 * instance, whose config changes through its repo's own PRs), the step says what to name in config.yaml instead.
 */
export function StarterCi({ canEdit, initialView = null, initialOpen = false, inForm = true, onCheckRan }: { canEdit: boolean; initialView?: View | null; initialOpen?: boolean; inForm?: boolean; onCheckRan?: (check: string) => void }) {
  const [view, setView] = useState<View | null>(initialView);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(initialOpen);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(initialView?.file ?? '');
  const [sent, setSent] = useState(false);
  useEffect(() => {
    if (initialView) return;
    getStarterCi()
      .then((v) => (setView(v), setText(v.file)))
      .catch((e: Error) => setError(e.message));
  }, [initialView]);
  const ran = !!view && view.onBranch && view.firstRun.state === 'done';
  useEffect(() => {
    if (ran && view) onCheckRan?.(view.check);
    // once per view: the form selects it, and the person may still take it out
  }, [ran]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!canEdit) return null;
  if (error) return <p className="text-[12px] text-red" data-testid="starter-ci-error">starter CI: {error}</p>;
  if (!view) return null;
  const branch = view.branch;
  if (view.onBranch) {
    return (
      <p className="rounded-lg bg-surface p-3 text-[12.5px] text-ink-2 shadow-hairline" data-testid="starter-ci-status" data-state={view.firstRun.state}>
        {view.firstRun.state === 'done'
          ? inForm
            ? `The workflow's check ${view.check} finished on ${branch} (${view.firstRun.conclusion ?? 'no conclusion'}): it is selected above as a required check. Review the change, then propose it.`
            : `The workflow's check ${view.check} finished on ${branch} (${view.firstRun.conclusion ?? 'no conclusion'}): name it in config.yaml required_checks (required_checks: [${view.check}]) through a PR, and merge it.`
          : view.firstRun.state === 'running'
            ? `The workflow is on ${branch}; its check ${view.check} is still running there. Once it finishes, ${inForm ? 'it is offered above as a required check' : 'name it in config.yaml required_checks through a PR'}.`
            : `${view.path} is on ${branch}, but GitHub has no ${view.check} check on its tip yet. Once it has run there, ${inForm ? 'it is offered above as a required check' : 'name it in config.yaml required_checks through a PR'}.`}
      </p>
    );
  }
  return (
    <div className="space-y-2 rounded-lg bg-surface p-3 shadow-hairline" data-testid="starter-ci">
      <p className="text-[12.5px] text-ink">
        No CI here? Add a starter CI: a GitHub Actions workflow whose check, <span className="font-mono text-[12px]">{view.check}</span>, a PR then waits on.
      </p>
      {!open ? (
        <button type="button" className={cx(btn, 'bg-surface text-ink shadow-btn hover:bg-hover')} onClick={() => setOpen(true)} data-testid="starter-ci-add">
          Add a starter CI…
        </button>
      ) : (
        <div className="space-y-2" data-testid="starter-ci-preview" data-placeholder={view.placeholder ? 'true' : 'false'}>
          <p className="text-[12.5px] text-ink" data-testid="starter-ci-summary">
            {view.summary}
          </p>
          <p className="font-mono text-[12px] text-ink-3">{view.path}</p>
          {editing ? (
            <textarea value={text} onChange={(e) => (setText(e.target.value), setSent(false))} rows={16} spellCheck={false} className="block w-full rounded-lg bg-field p-2 font-mono text-[12px] text-ink shadow-hairline outline-none" data-testid="starter-ci-edit" />
          ) : (
            <pre className="max-h-72 overflow-auto rounded-lg bg-field p-2 font-mono text-[12px] text-ink shadow-hairline" data-testid="starter-ci-file">
              {text}
            </pre>
          )}
          <div className="flex flex-wrap gap-2">
            <a href={withValue(view.newFile, text)} target="_blank" rel="noreferrer" onClick={() => setSent(true)} className={cx(btn, 'bg-ink text-surface hover:opacity-90')} data-testid="starter-ci-confirm">
              Confirm: commit it on GitHub…
            </a>
            <button type="button" className={cx(btn, 'text-ink-2 hover:bg-hover-2 hover:text-ink')} onClick={() => setEditing(!editing)} data-testid="starter-ci-change">
              {editing ? 'Done editing' : 'Change'}
            </button>
          </div>
          <p className={cx('text-[12px]', sent ? 'text-green' : 'text-ink-3')} data-testid="starter-ci-next">
            {sent
              ? `On GitHub: commit it on a new branch and open its PR, then merge it. Once its first run on ${branch} finishes, ${inForm ? 'its check is offered here' : 'this step says so'}.`
              : `Confirm opens GitHub's new-file page with this file in it: you commit it and open the PR as yourself; nothing here writes a workflow.`}
          </p>
        </div>
      )}
    </div>
  );
}
