// WHY: the one-command install prints a URL without the dashboard's key (src/dashboard-detach.ts), so the page asks
// for it once: typed into a hidden field or read from its file, never put in the address bar.
import { useEffect, useState, type FormEvent } from 'react';
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

/** The key's file and a command that copies it, from this machine's dashboard (GET /api/key-help); never the key. */
export interface KeyHelpData {
  file: string;
  copy: string | null;
}

/**
 * WHY: on macOS the key's file is under ~/Library/Application Support, which a browser's file picker hides and whose
 * space breaks a pasted path (#467). So the page shows the path, whole and selectable, and the command that copies it.
 */
export function KeyHelp({ help }: { help: KeyHelpData }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-4 space-y-2 rounded-control bg-canvas p-3 text-[12.5px] text-ink-2" data-testid="key-help">
      <div>The key is in this file on this machine (only you can read it):</div>
      <code className="block select-all break-all font-mono text-[12px] text-ink" data-testid="key-help-file">
        {help.file}
      </code>
      {help.copy ? (
        <>
          <div>Run this in a terminal here to copy the key, then paste it below:</div>
          <div className="flex items-start gap-2">
            <code className="block min-w-0 flex-1 select-all break-all font-mono text-[12px] text-ink" data-testid="key-help-command">
              {help.copy}
            </code>
            <button
              type="button"
              data-testid="key-help-copy"
              className="shrink-0 rounded-control border border-line px-2 py-0.5 text-[12px] text-ink hover:bg-surface"
              onClick={() => void navigator.clipboard?.writeText(help.copy!).then(() => setCopied(true), () => setCopied(false))}
            >
              {copied ? 'Copied' : 'Copy command'}
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** The help, when this page is opened on the dashboard's own machine (the server answers only there); else nothing. */
function useKeyHelp(): KeyHelpData | null {
  const [help, setHelp] = useState<KeyHelpData | null>(null);
  useEffect(() => {
    let live = true;
    fetch('/api/key-help', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<KeyHelpData>) : null))
      .then((h) => live && h && typeof h.file === 'string' && setHelp({ file: h.file, copy: typeof h.copy === 'string' ? h.copy : null }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return help;
}

/** WHY: where the key is depends on the machine; the install command printed the file's path, never the key. */
export function KeyPage({ brand, help: given }: { brand?: string; help?: KeyHelpData | null }) {
  const fetched = useKeyHelp();
  const help = given !== undefined ? given : fetched;
  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6" data-testid="key-page">
      <div className="w-[min(420px,100%)] rounded-card bg-surface p-6 shadow-card">
        <h1 className="text-[17px] font-semibold text-ink">Open {brand ?? 'the dashboard'}</h1>
        <p className="mt-2 text-[13px] leading-5 text-ink-2">
          Paste the dashboard key, or choose its file. The install command printed where it is: a file only you can read on this machine. This tab keeps it until you close it.
        </p>
        {help ? <KeyHelp help={help} /> : null}
        <KeyForm hub={false} />
      </div>
    </div>
  );
}
