// The chat's attachments (src/chat-attachments.ts), for the owners and the writers: files dropped on the panel,
// pasted into the box or picked with the paperclip are uploaded to the instance at once and shown as chips (name,
// size, remove). A file that looks like it holds a secret is held back with the kinds found (never the value) until
// the person chooses "Attach anyway". The server decides every type and size again; this only says so sooner.
// A sent attachment opens through the dashboard with the normal sign-in: an image in a new tab, anything else as a
// download. Nothing attached ever runs.
import { useEffect, useRef, useState } from 'react';
import { FileText, Image as ImageIcon, Paperclip, X } from 'lucide-react';
import { chatAttachmentBlob, chatAttachmentLimits, removeChatAttachment, uploadChatAttachment, type ChatAttachment, type ChatAttachmentLimits } from '../api';
import { Button, cx } from './ui';

/** Only the owners and the writers attach files; a viewer never sees the button (and the server refuses them). */
export const mayAttach = (role: string | undefined) => role === 'owner' || role === 'writer';

export function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** One file in the composer: uploading, attached, held back for a secret, or refused. */
export interface Pending {
  key: string;
  name: string;
  size: number;
  state: 'uploading' | 'ready' | 'secret' | 'error';
  attachment?: ChatAttachment;
  /** The kinds of secret the server saw (never the value). */
  kinds?: string[];
  why?: string;
  /** False: kept without a secret scan (an image, PDF or Office file; the scan reads text only). */
  scanned?: boolean;
  file?: File;
}

const extOf = (name: string) => {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/**
 * What the browser can tell before uploading: a type the chat doesn't take, a file over the per-file cap, one too
 * many, or the question's total over its cap. The server checks all of it again (and the bytes, which this can't).
 */
export function precheck(files: { name: string; size: number }[], have: { size: number }[], l: ChatAttachmentLimits | null): { name: string; why: string | null }[] {
  let total = have.reduce((n, f) => n + f.size, 0);
  let count = have.length;
  return files.map((f) => {
    if (!l) return { name: f.name, why: null };
    const ext = extOf(f.name);
    if (/^(docm|dotm|xlsm|xltm|xlam|xlsb|pptm|potm|ppsm|ppam|sldm)$/.test(ext)) return { name: f.name, why: 'macro-enabled Office files are refused: nothing attached may run' };
    if (ext && !l.extensions.includes(ext)) return { name: f.name, why: `.${ext} isn't a type the chat takes` };
    if (f.size > l.maxFileMb * 1024 * 1024) return { name: f.name, why: `over the ${l.maxFileMb} MB limit per file` };
    if (count + 1 > l.maxFiles) return { name: f.name, why: `at most ${l.maxFiles} files on one question` };
    if (total + f.size > l.maxMessageMb * 1024 * 1024) return { name: f.name, why: `over the ${l.maxMessageMb} MB limit per question` };
    total += f.size;
    count += 1;
    return { name: f.name, why: null };
  });
}

/** The files a drop or a paste carries (none for plain text). */
export function filesOf(dt: Pick<DataTransfer, 'files'> | null): File[] {
  return dt ? Array.from(dt.files ?? []) : [];
}

let seq = 0;

/** The composer's attachments on one instance (`instance`: a hub's chosen one, or null for this page's own). */
export function useAttachments({ instance, active }: { instance: string | null; active: boolean }) {
  const [items, setItems] = useState<Pending[]>([]);
  const [limits, setLimits] = useState<ChatAttachmentLimits | null>(null);
  const live = useRef(items);
  live.current = items;
  useEffect(() => {
    if (!active) return;
    void chatAttachmentLimits(instance)
      .then(setLimits)
      .catch(() => setLimits(null));
  }, [active, instance]);
  const patch = (key: string, p: Partial<Pending>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));
  const upload = async (key: string, file: File, anyway: boolean) => {
    patch(key, { state: 'uploading' });
    try {
      const r = await uploadChatAttachment(instance, file, anyway);
      if ('secret' in r) patch(key, { state: 'secret', kinds: r.secret, why: r.error });
      else patch(key, { state: 'ready', attachment: r.attachment, kinds: r.secretKinds, ...(r.scanned === false ? { scanned: false } : {}), file: undefined });
    } catch (e) {
      patch(key, { state: 'error', why: (e as Error).message });
    }
  };
  const add = (files: File[]) => {
    const kept = live.current.filter((x) => x.state !== 'error');
    const checks = precheck(files, kept, limits);
    const next: Pending[] = files.map((f, i) => ({ key: `a${++seq}`, name: f.name, size: f.size, state: checks[i]!.why ? 'error' : 'uploading', ...(checks[i]!.why ? { why: checks[i]!.why! } : { file: f }) }));
    setItems((xs) => [...xs, ...next]);
    for (const p of next) if (p.state === 'uploading') void upload(p.key, p.file!, false);
  };
  const remove = (key: string) => {
    const x = live.current.find((i) => i.key === key);
    setItems((xs) => xs.filter((i) => i.key !== key));
    if (x?.attachment) void removeChatAttachment(instance, x.attachment.id).catch(() => {});
  };
  const anyway = (key: string) => {
    const x = live.current.find((i) => i.key === key);
    if (x?.file) void upload(key, x.file, true);
  };
  const ready = items.filter((x) => x.state === 'ready' && x.attachment).map((x) => x.attachment!);
  return { items, limits, add, remove, anyway, ready, busy: items.some((x) => x.state === 'uploading'), blocked: items.some((x) => x.state === 'secret'), clear: () => setItems([]) };
}

/** One composer chip: the file's name and size, its state, and remove; a secret warning asks before it is attached. */
export function AttachmentChip({ a, onRemove, onAnyway }: { a: Pending; onRemove: () => void; onAnyway: () => void }) {
  return (
    <div className={cx('max-w-full rounded-control px-2 py-1 text-[12px] shadow-hairline', a.state === 'error' ? 'bg-inset text-red' : a.state === 'secret' ? 'bg-inset text-ink' : 'bg-inset text-ink')} data-testid="chat-attachment-chip" data-state={a.state}>
      <div className="flex min-w-0 items-center gap-1.5">
        {/\.(png|jpe?g|gif|webp)$/i.test(a.name) ? <ImageIcon className="size-3.5 shrink-0 text-ink-3" /> : <FileText className="size-3.5 shrink-0 text-ink-3" />}
        <span className="truncate font-medium" data-testid="chat-attachment-name">
          {a.name}
        </span>
        <span className="shrink-0 tabular-nums text-ink-3" data-testid="chat-attachment-size">
          {fmtSize(a.size)}
        </span>
        {a.state === 'uploading' && <span className="shrink-0 text-ink-3">uploading…</span>}
        <button type="button" onClick={onRemove} className="primitive-icon-button ml-auto size-5 shrink-0 text-ink-3 hover:bg-hover-2 hover:text-ink" aria-label={`Remove ${a.name}`} data-testid="chat-attachment-remove">
          <X className="size-3" />
        </button>
      </div>
      {a.state === 'error' && (
        <div className="mt-0.5 text-[11.5px]" data-testid="chat-attachment-error">
          {a.why}
        </div>
      )}
      {a.state === 'ready' && a.scanned === false && (
        <div className="mt-0.5 text-[11.5px] text-ink-3" data-testid="chat-attachment-unscanned">
          Not scanned for secrets: the scan reads text files only.
        </div>
      )}
      {a.state === 'secret' && (
        <div className="mt-1 space-y-1" data-testid="chat-attachment-secret">
          <div className="text-[11.5px] text-red">This file looks like it contains a secret: {(a.kinds ?? []).join(', ')}. It isn't attached.</div>
          <Button size="sm" variant="outline" onClick={onAnyway} data-testid="chat-attachment-anyway">
            Attach anyway
          </Button>
        </div>
      )}
    </div>
  );
}

/** The paperclip: picks files to attach. Rendered only for the owners and the writers. */
export function AttachButton({ role, disabled, why, accept, onFiles }: { role: string | undefined; disabled?: boolean; why?: string; accept?: string[]; onFiles: (f: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  if (!mayAttach(role)) return null;
  return (
    <>
      <button type="button" disabled={disabled} title={why ?? 'Attach files (or drop or paste them)'} onClick={() => input.current?.click()} className="primitive-icon-button size-7 text-ink-3 hover:bg-hover-2 hover:text-ink disabled:opacity-40" aria-label="Attach files" data-testid="chat-attach">
        <Paperclip className="size-4" />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept={accept?.map((e) => `.${e}`).join(',')}
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
        data-testid="chat-attach-input"
      />
    </>
  );
}

/** What shows over the panel while files are dragged onto it. */
export function DropHint({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-card border-2 border-dashed border-blue bg-surface/80 text-[13px] font-medium text-ink" data-testid="chat-drop">
      Drop files to attach them
    </div>
  );
}

/** The image types a sent attachment may open as in a tab: raster only, never SVG (which can hold script). */
export const VIEWABLE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * What the browser opens: a blob: URL is this page's origin and keeps none of the server's headers (no sandbox, no
 * nosniff), so the type is decided here. A raster image the allowlist names opens in a tab; anything else, whatever
 * type the server (or an instance through the hub) said, becomes opaque bytes and downloads, never a page.
 */
export function safeBlob(b: Blob): { blob: Blob; view: boolean } {
  const type = b.type.split(';')[0]!.trim().toLowerCase();
  if (VIEWABLE_IMAGE_TYPES.includes(type)) return { blob: new Blob([b], { type }), view: true };
  return { blob: new Blob([b], { type: 'application/octet-stream' }), view: false };
}

/** A question's sent attachments: each opens through the dashboard (an image in a new tab, anything else downloads). */
export function SentAttachments({ items, instance }: { items: ChatAttachment[]; instance: string | null }) {
  const [err, setErr] = useState<string | null>(null);
  if (!items.length) return null;
  const open = async (a: ChatAttachment) => {
    setErr(null);
    try {
      const { blob, view } = safeBlob(await chatAttachmentBlob(instance, a.id));
      const url = URL.createObjectURL(blob);
      if (view) window.open(url, '_blank', 'noopener');
      else {
        const link = document.createElement('a');
        link.href = url;
        link.download = a.name;
        link.click();
      }
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5" data-testid="chat-sent-attachments">
      {items.map((a) => (
        <button key={a.id} type="button" onClick={() => void open(a)} className="inline-flex h-6 max-w-full items-center gap-1 rounded-full bg-surface px-2 text-[11.5px] text-ink-2 shadow-hairline hover:bg-hover-2" title={a.kind === 'image' ? 'Open' : 'Download'} data-testid="chat-sent-attachment">
          <Paperclip className="size-3 shrink-0" />
          <span className="truncate">{a.name}</span>
          <span className="shrink-0 tabular-nums text-ink-3">{fmtSize(a.size)}</span>
        </button>
      ))}
      {err && <div className="w-full text-[11.5px] text-red">{err}</div>}
    </div>
  );
}

/** The composer's chips, above the box. */
export function AttachmentList({ items, onRemove, onAnyway }: { items: Pending[]; onRemove: (key: string) => void; onAnyway: (key: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="flex flex-col gap-1.5" data-testid="chat-attachments">
      {items.map((a) => (
        <AttachmentChip key={a.key} a={a} onRemove={() => onRemove(a.key)} onAnyway={() => onAnyway(a.key)} />
      ))}
    </div>
  );
}
