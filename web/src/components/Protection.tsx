// How the default branch is guarded (src/main-watch.ts): "GitHub enforced", or the harness's own guard (the main
// watch) with the last commit it checked; and, on every page, an unaccounted commit's alert, which only an admin
// clears. A viewer is sent the mode only, so that is all this shows them.
import { useState } from 'react';
import { clearAutoMergeStop, type Protection } from '../api';
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
    <section className="space-y-1.5" aria-label="Default branch protection" data-testid="protection-status">
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
        </div>
      )}
    </section>
  );
}

/** An unaccounted commit stopped auto-merge: shown on every page until an admin clears it. */
export function MainWatchAlert({ protection, onCleared }: { protection: Protection | undefined; onCleared?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const a = protection?.alert;
  if (!a) return null;
  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      await clearAutoMergeStop();
      onCleared?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
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
        {a.revert ? (
          <>
            A revert PR waits for a human:{' '}
            <a className="underline-offset-2 hover:underline" href={a.revert} target="_blank" rel="noreferrer">
              {a.revert}
            </a>
            .
          </>
        ) : (
          'No revert PR was opened.'
        )}
      </span>
      {protection?.canClear && (
        <div className="mt-2 flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void clear()} data-testid="main-watch-clear">
            Clear and resume auto-merge
          </Button>
          {error && <span className="text-[12px] text-red">{error}</span>}
        </div>
      )}
    </div>
  );
}
