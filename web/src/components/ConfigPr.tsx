// WHY (#468): every config PR the first-run page follows (setup mode's setup PR, each Repo config change after) shows
// the same way and ends the same way: open, with Merge here (the command shown first, then Confirm); merged wherever
// (here, on GitHub, from the CLI), with who merged it, when, and where this checkout is now; or, when the checkout
// couldn't be fast-forwarded, exactly why, with Fast-forward now once that's fixed, or the command. MERGED is never an
// error. The server does each of these for the owners only (src/config-pr.ts).
import { useState } from 'react';
import { configPrAction, type ConfigPr } from '../api';
import { ago, Badge, Button, Card, cx } from './ui';

const code = 'block overflow-x-auto whitespace-pre rounded-lg bg-surface px-3 py-2 font-mono text-[12px] text-ink shadow-hairline';

export function ConfigPrRow({ pr, canAct, initialPlan = null, onDone }: { pr: ConfigPr; canAct: boolean; initialPlan?: { command: string; then: string } | null; onDone: () => void }) {
  const [plan, setPlan] = useState<{ command: string; then: string } | null>(initialPlan);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const act = async (f: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await f();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const merge = (confirm: boolean) =>
    act(async () => {
      const r = await configPrAction(pr.number, 'merge', confirm);
      if (!confirm) return setPlan({ command: r.command || 'nothing to run: it is merged already', then: r.then ?? '' });
      setPlan(null);
      setMsg({ ok: !!r.synced, text: r.detail ?? `merged PR #${r.number}` });
      onDone();
    });
  const sync = () =>
    act(async () => {
      const r = await configPrAction(pr.number, 'sync', true);
      setMsg({ ok: !!r.synced, text: r.detail ?? '' });
      onDone();
    });
  const label = `${pr.kind === 'setup' ? 'The setup PR' : 'Config PR'} #${pr.number}`;
  const merged = pr.state === 'merged';
  return (
    <li className="space-y-2 px-4 py-3" data-testid="config-pr" data-number={pr.number} data-state={pr.state} data-synced={pr.synced}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <a href={pr.url} target="_blank" rel="noreferrer" className="text-[13px] font-medium text-blue-ink hover:underline">
          {label}
        </a>
        <Badge tone={merged && pr.synced ? 'ok' : merged || pr.state === 'open' ? 'info' : 'neutral'}>{merged ? (pr.synced ? 'merged, in this checkout' : 'merged') : pr.state === 'open' ? 'open' : pr.state === 'closed' ? 'closed' : 'unknown'}</Badge>
      </div>
      {merged && pr.synced && (
        <p className="break-words text-[12.5px] text-green" data-testid="config-pr-done">
          Merged{pr.mergedBy ? ` by @${pr.mergedBy}` : ''}
          {pr.mergedAt ? ` at ${new Date(pr.mergedAt).toLocaleString()} (${ago(pr.mergedAt)})` : ''}, checkout at <span className="font-mono">{pr.sha?.slice(0, 7) ?? 'it'}</span>.
        </p>
      )}
      {merged && !pr.synced && pr.why && (
        <div className="space-y-1.5" data-testid="config-pr-why">
          <p className="break-words text-[12.5px] text-orange">
            Merged{pr.mergedBy ? ` by @${pr.mergedBy}` : ''}, but this checkout isn't at it yet: {pr.why}
          </p>
          {pr.retry && canAct ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void sync()} data-testid="config-pr-sync">
              {busy ? 'Fast-forwarding…' : 'Fast-forward now'}
            </Button>
          ) : (
            pr.command && <code className={code} data-testid="config-pr-command">{pr.command}</code>
          )}
        </div>
      )}
      {pr.state === 'closed' && pr.why && <p className="break-words text-[12.5px] text-ink-2">{pr.why}</p>}
      {pr.state === 'open' &&
        (!canAct ? (
          <p className="text-[12.5px] text-ink-3">Merge it on GitHub; this page notices the merge and brings the config into this checkout.</p>
        ) : !plan ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void merge(false)} data-testid="config-pr-merge-review">
              Merge PR #{pr.number} here…
            </Button>
            <span className="text-[12px] text-ink-3">or merge it on GitHub: this page notices either way.</span>
          </div>
        ) : (
          <div className="space-y-2 rounded-lg bg-blue-tint p-3" data-testid="config-pr-merge-confirming">
            <p className="text-[12.5px] text-ink">It runs, as your approval:</p>
            <code className={code}>{plan.command}</code>
            <p className="text-[12.5px] text-ink-2">{plan.then}.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={busy} onClick={() => void merge(true)} work="lands" data-testid="config-pr-merge-confirm">
                {busy ? 'Merging…' : 'Confirm merge'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPlan(null)} data-testid="config-pr-merge-cancel">
                Cancel
              </Button>
            </div>
          </div>
        ))}
      {msg && (
        <p className={cx('break-words text-[12.5px]', msg.ok ? 'text-green' : 'text-red')} data-testid="config-pr-result">
          {msg.text}
        </p>
      )}
    </li>
  );
}

/** The config PRs, newest first, under the Repo config steps. */
export function ConfigPrList({ prs, canAct, onDone }: { prs: ConfigPr[]; canAct: boolean; onDone: () => void }) {
  if (!prs.length) return null;
  return (
    <section aria-label="Config PRs" className="space-y-1.5" data-testid="config-prs">
      <h2 className="text-[13px] font-medium text-ink">Config PRs</h2>
      <Card className="overflow-hidden">
        <ul className="divide-y divide-line">
          {[...prs].reverse().map((p) => (
            <ConfigPrRow key={p.number} pr={p} canAct={canAct} onDone={onDone} />
          ))}
        </ul>
      </Card>
    </section>
  );
}
