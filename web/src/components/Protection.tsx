// How the default branch is guarded (src/main-watch.ts): "GitHub enforced", or the harness's own guard (the main
// watch) with the last commit it checked; and, on every page, an unaccounted commit's alert, which only an admin
// clears. A viewer is sent the mode only, so that is all this shows them. An admin may accept a hand merge as a
// bootstrap merge (by sha, or by PR number before it merges); owners and writers see what was accepted.
import { useState } from 'react';
import { acceptBootstrapMerge, clearAutoMergeStop, type DirectPush, type Protection } from '../api';
import { ago, Badge, Button } from './ui';

export function modeLabel(mode: Protection['mode'], brand: string): string {
  if (mode === 'github') return 'GitHub enforced';
  if (mode === 'main_watch') return `${brand} guard (main watch)`;
  if (mode === 'off') return 'Off';
  return 'Not checked yet';
}

/** The protection mode, and for owners and writers why and the last commit checked. */
export function ProtectionStatus({ protection, brand }: { protection: Protection | undefined; brand: string }) {
  if (!protection) return null;
  const tone = protection.mode === 'github' || protection.mode === 'main_watch' ? 'ok' : 'warn';
  return (
    <section id="main-watch" className="space-y-1.5" aria-label="Default branch protection" data-testid="protection-status">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Default branch protection</span>
        <Badge tone={tone}>
          <span data-testid="protection-mode">{modeLabel(protection.mode, brand)}</span>
        </Badge>
      </div>
      {(protection.detail || (protection.mode === 'main_watch' && protection.lastChecked !== undefined)) && (
        <div className="rounded-card bg-surface px-3 py-2.5 text-[12.5px] text-ink-2 shadow-card">
          {protection.detail && <div>{protection.detail}</div>}
          {protection.mode === 'main_watch' && (
            <div className="text-ink-3" data-testid="protection-last-checked">
              {protection.lastChecked ? (
                <>
                  Last commit checked:{' '}
                  <a className="font-mono text-ink underline-offset-2 hover:underline" href={protection.lastChecked.url} target="_blank" rel="noreferrer">
                    {protection.lastChecked.sha.slice(0, 8)}
                  </a>
                  {protection.lastChecked.at ? `, ${ago(protection.lastChecked.at)}` : ''}
                </>
              ) : (
                'No commit checked yet: the next tip of the default branch is the starting point.'
              )}
            </div>
          )}
          {protection.mode === 'main_watch' && protection.directPush && <DirectPushLine push={protection.directPush} />}
        </div>
      )}
      {protection.mode === 'main_watch' && <DeadChecks protection={protection} />}
      {protection.mode === 'main_watch' && <AcceptedMerges protection={protection} />}
    </section>
  );
}

/**
 * A required check raised as dead by the main watch (src/main-watch.ts protectionView): no run on any commit judged
 * since. `workflow`: the Actions workflow that would post it is disabled (its state as GitHub reports it).
 */
type DeadCheck = { check: string; since: string; workflow?: { name: string; path: string; state: string } };

/** Why a disabled workflow is off, from GitHub's state for it. */
export function workflowOff(state: string): string {
  if (state === 'disabled_manually') return 'turned off by hand';
  if (state === 'disabled_inactivity') return 'turned off by GitHub for inactivity';
  return 'turned off';
}

/** Each dead required check, until a run of it appears: why every merge keeps tripping the watch. */
export function DeadChecks({ protection }: { protection: Protection & { deadChecks?: DeadCheck[] } }) {
  const list = protection.deadChecks ?? [];
  if (!list.length) return null;
  return (
    <div className="rounded-card bg-surface px-3 py-2.5 text-[12.5px] text-ink-2 shadow-card" data-testid="main-watch-dead-checks">
      {list.map((d) => (
        <div key={d.check} data-testid="main-watch-dead-check">
          <Badge tone="warn">No runs</Badge> Required check <span className="font-mono text-ink">{d.check}</span> has had no run on any commit checked since {ago(d.since)}. Merges keep tripping the watch until it posts, or until it leaves required_checks in config.yaml.
          {d.workflow && (
            <div className="mt-1 text-ink-3" data-testid="main-watch-dead-check-workflow">
              Its workflow <span className="text-ink">{d.workflow.name}</span> (<span className="font-mono">{d.workflow.path}</span>) is disabled on GitHub ({d.workflow.state}: {workflowOff(d.workflow.state)}), so it can't post the check until someone enables it again.
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** The last commit that landed without a PR, and whether its ops-channel alert went out (and whom it mentioned). */
export function DirectPushLine({ push }: { push: DirectPush }) {
  const what = push.kind === 'rewrite' ? 'Force-push (rewrite)' : 'Direct push';
  const alert =
    push.status === 'posted'
      ? `posted to the ops channel${push.mentioned ? `, mentioning ${push.mentioned} owner${push.mentioned === 1 ? '' : 's'}` : ''}`
      : push.status === 'pending'
        ? 'waiting to be posted to the ops channel (the limit on ops posts)'
        : 'not posted';
  return (
    <div className="text-ink-3" data-testid="main-watch-direct-push">
      {what}:{' '}
      <a className="font-mono text-ink underline-offset-2 hover:underline" href={push.url} target="_blank" rel="noreferrer">
        {push.sha.slice(0, 8)}
      </a>
      {push.pusher ? ` by ${push.pusher}` : ''}, {ago(push.at)}; {alert}
      {push.note ? `: ${push.note}` : ''}.
    </div>
  );
}

/**
 * Bootstrap merges: while a required check can't run yet, an admin's hand merge would trip the watch. An admin accepts
 * it here first (a commit on the branch not checked yet, or a PR's merge to come, pinned to its head now); the watch
 * then counts it accounted. It never clears a stop. Owners and writers see the list; only an admin gets the field.
 */
export function AcceptedMerges({ protection }: { protection: Protection }) {
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!protection.accepted && !protection.canAccept) return null;
  const list = protection.accepted ?? [];
  const submit = async () => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await acceptBootstrapMerge(target, reason);
      setDone(`Accepted ${target.trim()}.`);
      setTarget('');
      setReason('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const field = 'h-7 rounded-control bg-field px-2 text-[12.5px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--ring)]';
  return (
    <div className="rounded-card bg-surface px-3 py-2.5 text-[12.5px] text-ink-2 shadow-card" data-testid="main-watch-accepted">
      <div className="text-[12.5px] font-medium text-ink">Accepted bootstrap merges</div>
      {list.length ? (
        <ul className="mt-1 space-y-0.5">
          {list.map((a) => (
            <li key={a.id} data-testid="main-watch-accepted-row">
              <span className="font-mono text-ink">{a.pr ? `#${a.pr} at ${(a.head ?? '').slice(0, 8)}` : (a.sha ?? '').slice(0, 8)}</span>
              {` by @${a.by}, ${ago(a.at)}: ${a.reason}`}
              <span className="text-ink-3">{a.appliedTo ? ` (accounted: ${a.appliedTo.slice(0, 8)})` : ' (not reached yet)'}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-1 text-ink-3">None.</div>
      )}
      {protection.canAccept && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          data-testid="main-watch-accept"
        >
          <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="sha or PR number" aria-label="commit sha or PR number to accept" className={`${field} w-40 font-mono`} data-testid="main-watch-accept-target" />
          <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="reason (recorded in the audit)" aria-label="reason" className={`${field} min-w-0 flex-1`} data-testid="main-watch-accept-reason" />
          <Button size="sm" variant="outline" type="submit" disabled={busy || !target.trim() || !reason.trim()} data-testid="main-watch-accept-submit">
            Accept as bootstrap merge
          </Button>
          {error && <span className="text-[12px] text-red">{error}</span>}
          {done && <span className="text-[12px] text-ink-3">{done}</span>}
          <div className="w-full text-[12px] text-ink-3">
            A commit on the branch not checked yet, or a PR before you merge it (pinned to its head now). It doesn't clear a stop.
          </div>
        </form>
      )}
    </div>
  );
}

/** Whether a refused resume opens the acknowledgement form: a 409 whose body asks for one (`needsAck`), never another refusal (#776). */
export function opensAckForm(e: unknown): boolean {
  const x = e as { status?: unknown; body?: { needsAck?: unknown } } | null;
  return !!x && x.status === 409 && x.body?.needsAck === true;
}

/**
 * What counts toward the reason's minimum, as the server counts it (src/auto-merge-resume.ts): letters, digits,
 * punctuation and symbols that print (no default-ignorables such as the Hangul fillers, no braille blank).
 */
export const visibleChars = (s: string) => s.match(/(?![\p{Default_Ignorable_Code_Point}⠀])[\p{L}\p{N}\p{P}\p{S}]/gu)?.length ?? 0;
const ACK_MIN = 10;

/** Whether a resume answer was a recorded request the coordinator decides (#776 on #727), not a resume done now. */
export function isResumeRequest(r: unknown): boolean {
  return (r as { how?: unknown } | null)?.how === 'requested';
}

/**
 * An admin's resume of a stop in force. A stop the default branch caused is a recorded request: the coordinator resumes
 * it once main is green under the pinned-source verdict, and the answer says so, with its last measurement; a separate
 * confirm with a typed reason asks it to resume anyway, recorded (#776 on #727).
 */
function ResumeControls({ onCleared }: { onCleared?: (() => void) | undefined }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [needsAck, setNeedsAck] = useState(false);
  const [ack, setAck] = useState('');
  const clear = async (acknowledge?: { reason: string }) => {
    setBusy(true);
    setError(null);
    try {
      const r = await clearAutoMergeStop(acknowledge);
      setAck('');
      if (isResumeRequest(r)) {
        setNotice(r.message ?? 'Recorded: the coordinator resumes auto-merge once the default branch is green.');
        setNeedsAck(!r.acknowledged);
      } else {
        setNotice(null);
        setNeedsAck(false);
      }
      onCleared?.();
    } catch (e) {
      setError((e as Error).message);
      setNeedsAck(opensAckForm(e));
    } finally {
      setBusy(false);
    }
  };
  const short = visibleChars(ack) < ACK_MIN ? `type a reason of at least ${ACK_MIN} visible characters` : null;
  return (
    <>
      <div className="mt-2 flex items-center gap-2">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void clear()} data-testid="main-watch-clear">
          Clear and resume auto-merge
        </Button>
        {error && <span className="text-[12px] text-red">{error}</span>}
      </div>
      {notice && (
        <div className="mt-2 text-[12px] text-ink-2" data-testid="main-watch-resume-requested">
          {notice}
        </div>
      )}
      {needsAck && (
        <form
          className="mt-2 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!short) void clear({ reason: ack });
          }}
          data-testid="main-watch-ack"
        >
          <input
            value={ack}
            onChange={(e) => setAck(e.target.value)}
            placeholder="why resume while the default branch isn't green (recorded)"
            aria-label="reason to resume while the default branch isn't green"
            className="h-7 min-w-0 flex-1 rounded-control bg-field px-2 text-[12.5px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--ring)]"
            data-testid="main-watch-ack-reason"
          />
          <Button size="sm" variant="outline" type="submit" disabled={busy} why={short} data-testid="main-watch-ack-submit">
            Acknowledge and resume anyway
          </Button>
        </form>
      )}
    </>
  );
}

/**
 * Auto-merge stopped, shown on every page until an admin resumes it: an unaccounted commit's alert (the main watch),
 * or, for any other stop in force (a red default branch after an auto-merge), its reason (#776).
 */
export function MainWatchAlert({ protection, onCleared }: { protection: Protection | undefined; onCleared?: () => void }) {
  const a = protection?.alert;
  if (!a) {
    if (!protection?.stopped) return null;
    return (
      <div role="alert" className="mx-6 mt-4 rounded-card bg-red-tint px-4 py-3 text-[13px] shadow-[0_0_0_1px_var(--red-tint)]" data-testid="auto-merge-stopped">
        <span className="font-semibold text-red">Auto-merge is stopped</span>
        <span className="text-ink-2"> {protection.stopped}. Every PR waits for you until an admin resumes it.</span>
        {protection.canClear && <ResumeControls onCleared={onCleared} />}
      </div>
    );
  }
  return (
    <div role="alert" className="mx-6 mt-4 rounded-card bg-red-tint px-4 py-3 text-[13px] shadow-[0_0_0_1px_var(--red-tint)]" data-testid="main-watch-alert">
      <span className="font-semibold text-red">Unaccounted commit on the default branch</span>
      <span className="text-ink-2">
        {' '}
        {ago(a.at)}:{' '}
        <a className="font-mono underline-offset-2 hover:underline" href={a.url} target="_blank" rel="noreferrer">
          {a.sha.slice(0, 8)}
        </a>
        . {a.reason}. Auto-merge is stopped on this instance until an admin clears it.{' '}
        {a.revert || a.trip_revert ? (
          <>
            {a.revert ? 'A revert PR waits for a human: ' : "No revert PR of its own; its trip's revert PR waits for a human: "}
            <a className="underline-offset-2 hover:underline" href={a.revert ?? a.trip_revert ?? ''} target="_blank" rel="noreferrer" data-testid="main-watch-alert-revert">
              {a.revert ?? a.trip_revert}
            </a>
            .{!a.revert && a.no_revert ? <span data-testid="main-watch-alert-no-revert"> Why: {a.no_revert}.</span> : null}
          </>
        ) : a.no_revert ? (
          <span data-testid="main-watch-alert-no-revert">No revert PR was opened: {a.no_revert}.</span>
        ) : (
          'No revert PR was opened.'
        )}
      </span>
      {protection?.canClear && <ResumeControls onCleared={onCleared} />}
    </div>
  );
}
