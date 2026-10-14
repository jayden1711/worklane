// WHY: the one-command install prints a URL without the dashboard's key (src/dashboard-detach.ts), so the page asks
// for it once: typed into a hidden field or read from its file, never put in the address bar.
import { useState, type FormEvent } from 'react';
import { tryKey } from '../api';

export function KeyForm({ hub, initialError = null, onKept = () => window.location.reload() }: { hub: boolean; initialError?: string | null; onKept?: () => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const submit = async (given: string) => {
    setBusy(true);
    setError(null);
    const ok = await tryKey(given, { hub });
    setBusy(false);
    if (ok) onKept();
    else setError("That key doesn't open this dashboard.");
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void submit(key);
  };
  return (
    <form onSubmit={onSubmit} className="mt-5 space-y-3" data-testid="key-form">
      <label className="block text-[12.5px] font-medium text-ink" htmlFor="dash-key">
        Dashboard key
      </label>
      <input id="dash-key" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} data-testid="key-input" className="h-9 w-full rounded-control border border-line bg-canvas px-3 text-[13px] text-ink outline-none focus:border-ink-3" />
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={busy || !key.trim()} data-testid="key-submit" className="flex h-9 items-center justify-center rounded-control bg-ink px-4 text-[13.5px] font-medium text-surface hover:opacity-90 disabled:opacity-50">
          Open
        </button>
        <label className="cursor-pointer text-[12.5px] text-ink-2 underline" data-testid="key-file">
          or choose the key file
          <input type="file" className="sr-only" onChange={(e) => void e.target.files?.[0]?.text().then(submit)} />
        </label>
      </div>
      {error && (
        <p className="text-[12.5px] text-red" role="alert" data-testid="key-error">
          {error}
        </p>
      )}
    </form>
  );
}

/** WHY: where the key is depends on the machine; the install command printed the file's path, never the key. */
export function KeyPage({ brand }: { brand?: string }) {
  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6" data-testid="key-page">
      <div className="w-[min(420px,100%)] rounded-card bg-surface p-6 shadow-card">
        <h1 className="text-[17px] font-semibold text-ink">Open {brand ?? 'the dashboard'}</h1>
        <p className="mt-2 text-[13px] leading-5 text-ink-2">
          Paste the dashboard key, or choose its file. The install command printed where it is: a file only you can read on this machine. This tab keeps it until you close it.
        </p>
        <KeyForm hub={false} />
      </div>
    </div>
  );
}
