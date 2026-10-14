// Sign in to Claude, the first-run page's screen 2 (src/claude-signin.ts).
// Local: Sign in runs `claude auth login` as this machine's user, after a confirmation; the page shows Anthropic's
// sign-in link (owners only) and polls until `claude auth status` says signed in. Nothing is pasted.
// Server: the agents' token from `claude setup-token`, pasted into add-project's paste box (the existing
// paste_secret ask) when one is open, or at credentials.sh's hidden prompt.
// The account email is Claude Code's cached one (#341): always labelled cached, never shown as the current account.
import { useCallback, useEffect, useRef, useState } from 'react';
import { cancelClaudeSignin, getClaudeSignin, startClaudeSignin, type ClaudeSigninData, type ClaudeStatusView } from '../api';
import { navigate } from '../App';
import { SecretForm } from '../pages/Setup';
import { ago, Badge, Button, cx } from './ui';

/** How often the panel asks again while a sign-in is waiting (the server checks claude auth status every 2 s). */
export const SIGNIN_POLL_MS = 2_000;

const code = 'block overflow-x-auto whitespace-pre rounded-lg bg-inset px-3 py-2 font-mono text-[12px] text-ink shadow-hairline';
const STATE_LABEL = { idle: 'not started', waiting: 'waiting for you', done: 'signed in', failed: 'failed', cancelled: 'cancelled', 'timed-out': 'timed out' } as const;

function Cached({ account }: { account: string | null }) {
  if (!account) return null;
  return (
    <p className="break-words text-[12px] text-ink-3" data-testid="claude-signin-cached-account">
      Account: {account} (cached by Claude Code; it may predate a later token change)
    </p>
  );
}

function LocalView({ v, confirming, setConfirming, onChanged }: { v: Extract<ClaudeSigninData, { mode: 'local' }>; confirming: boolean; setConfirming: (b: boolean) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setConfirming(false);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const status: ClaudeStatusView | null = v.status;
  return (
    <div className="space-y-2 text-[12.5px] text-ink-2" data-testid="claude-signin" data-mode="local" data-state={v.state}>
      <p>
        Sign in runs <code className="font-mono text-[12px] text-ink">claude auth login</code> as this machine's user and shows Anthropic's sign-in page here. Nothing is pasted: Anthropic sends you back to Claude Code on this machine (localhost), so open it in a browser on this machine. The dashboard never sees, logs or stores a token; Claude Code keeps its own login.
      </p>
      {v.state !== 'idle' && (
        <p className="flex flex-wrap items-center gap-2" data-testid="claude-signin-state">
          <Badge tone={v.state === 'done' ? 'ok' : v.state === 'waiting' ? 'info' : 'warn'}>{STATE_LABEL[v.state]}</Badge>
          <span className="break-words">{v.detail}</span>
        </p>
      )}
      {v.state === 'waiting' && (
        <>
          {v.url ? (
            <a href={v.url} target="_blank" rel="noreferrer noopener" className="inline-flex h-7 items-center rounded-full bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90" data-testid="claude-signin-link">
              Open Anthropic's sign-in
            </a>
          ) : (
            !v.canAct && <p className="text-ink-3">The sign-in link is shown to the instance's owners only.</p>
          )}
          <p className="text-ink-3">This checks claude auth status every 2 s and marks the step done when it says signed in{v.startedAt ? ` (started ${ago(v.startedAt)})` : ''}.</p>
          {v.canAct && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(cancelClaudeSignin)} data-testid="claude-signin-cancel">
              Cancel
            </Button>
          )}
        </>
      )}
      {status?.loggedIn && <Cached account={status.cachedAccount} />}
      {v.state !== 'waiting' && (
        <>
          {!v.canAct ? (
            <p className="text-ink-3" data-testid="claude-signin-refused">
              Only the instance's owners can start it.
            </p>
          ) : !confirming ? (
            <Button size="sm" onClick={() => setConfirming(true)} data-testid="claude-signin-button">
              {v.state === 'idle' ? 'Sign in…' : 'Sign in again…'}
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-blue-tint p-3" data-testid="claude-signin-confirming">
              <span className="text-ink">Run claude auth login now?</span>
              <Button size="sm" disabled={busy} onClick={() => void act(startClaudeSignin)} data-testid="claude-signin-confirm">
                {busy ? 'Starting…' : 'Confirm'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          )}
          <p className="text-ink-3">The same in a terminal:</p>
          <code className={code}>claude auth login</code>
        </>
      )}
      {err && <p className="break-words text-red">{err}</p>}
    </div>
  );
}

function ServerView({ v, onChanged }: { v: Extract<ClaudeSigninData, { mode: 'server' }>; onChanged: () => void }) {
  const [err, setErr] = useState<string | null>(null);
  const s = v.status;
  return (
    <div className="space-y-2 text-[12.5px] text-ink-2" data-testid="claude-signin" data-mode="server">
      <p>
        The agents ({v.agentUser}) sign in with a token from <code className="font-mono text-[12px] text-ink">claude setup-token</code>, run on a machine signed in to the Claude account they should use. Paste it once: it is stored for {v.agentUser} only (0600), never shown or logged.
      </p>
      {v.ask ? (
        <div className="rounded-lg bg-surface p-3 shadow-hairline" data-testid="claude-signin-ask">
          <div className="text-[13px] font-medium text-ink">{v.ask.title}</div>
          <p className="break-words">{v.ask.detail}</p>
          {v.ask.canAnswer ? (
            <SecretForm a={v.ask} onDone={(e) => (e ? setErr(e) : onChanged())} />
          ) : (
            <p className="text-ink-3" data-testid="claude-signin-refused">
              Only the instance's owners can paste it.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2" data-testid="claude-signin-no-ask">
          <p>No paste box is open now. Add project, in the Setup console, asks for the token when the agents have none; run it again for this instance to get one.</p>
          <Button size="sm" variant="outline" onClick={() => navigate('/setup')} data-testid="claude-signin-setup">
            Open the Setup console
          </Button>
        </div>
      )}
      <p className="text-ink-3">Or at a root shell on the machine (a hidden prompt; for automation, the token on stdin):</p>
      <code className={code} data-testid="claude-signin-command">
        {v.command}
      </code>
      {s && (
        <p className={cx('break-words', s.loggedIn ? 'text-green' : 'text-ink-2')} data-testid="claude-signin-status">
          claude auth status as {v.agentUser}, {ago(s.at)}: {s.loggedIn ? `signed in${s.method ? ` (${s.method})` : ''}` : 'not signed in'}.
        </p>
      )}
      {s?.loggedIn && <Cached account={s.cachedAccount} />}
      {err && <p className="break-words text-red">{err}</p>}
    </div>
  );
}

/** The panel from its data (also what the render checks render). */
export function ClaudeSigninView({ v, initialConfirming = false, onChanged }: { v: ClaudeSigninData; initialConfirming?: boolean; onChanged: () => void }) {
  const [confirming, setConfirming] = useState(initialConfirming);
  return v.mode === 'server' ? <ServerView v={v} onChanged={onChanged} /> : <LocalView v={v} confirming={confirming} setConfirming={setConfirming} onChanged={onChanged} />;
}

/** The panel, loaded and kept current while a sign-in waits; `onDone` re-checks the page when it ends. */
export function ClaudeSigninPanel({ onDone }: { onDone: () => void }) {
  const [v, setV] = useState<ClaudeSigninData | { error: string } | null>(null);
  const wasWaiting = useRef(false);
  const load = useCallback(() => {
    getClaudeSignin()
      .then((d) => {
        const waitingNow = d.mode === 'local' && d.state === 'waiting';
        // A sign-in that just ended: the page checks the step again.
        if (wasWaiting.current && !waitingNow) onDone();
        wasWaiting.current = waitingNow;
        setV(d);
      })
      .catch((e: Error) => setV({ error: e.message }));
  }, [onDone]);
  useEffect(() => load(), [load]);
  const waiting = !!v && !('error' in v) && v.mode === 'local' && v.state === 'waiting';
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(load, SIGNIN_POLL_MS);
    return () => window.clearInterval(t);
  }, [waiting, load]);
  if (!v) return <p className="text-[12.5px] text-ink-3">Loading…</p>;
  if ('error' in v) return <p className="text-[12.5px] text-red">Can't load the sign-in: {v.error}</p>;
  return (
    <ClaudeSigninView
      v={v}
      onChanged={() => {
        load();
        if (v.mode === 'server') onDone();
      }}
    />
  );
}
