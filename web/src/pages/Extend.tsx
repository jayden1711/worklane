// WHY: Extend is where an instance's agents get more than the repo gives them: Plugins now, Automations as a second tab
// when it lands (one sidebar entry for both). Owners act; writers read what agents have; viewers aren't offered it.
// Every change is Review then Confirm (the PolicyForm pattern); approving ends in one root command shown here, because
// a dashboard can stage an approval but never make one (src/plugins/approval.ts).
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { getPlugins, pluginAction, type PluginEntry, type PluginPreview, type PluginReview, type PluginsView, type State } from '../api';
import { Header } from '../components/Header';
import { ago, Badge, Button, Card, cx } from '../components/ui';
import { navigate } from '../App';

const field = 'h-8 rounded-control bg-surface px-2 text-[13px] text-ink shadow-btn outline-none focus:ring-2 focus:ring-blue/40';
const TABS = [{ to: '/extend/plugins', label: 'Plugins' }] as const;

/** A copyable command, as the updater-signer card shows one. */
function CommandLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2">
      <code className="min-w-0 flex-1 break-all rounded-chip bg-surface px-2 py-1 font-mono text-[12px] shadow-hairline" data-testid="plugin-root-command">
        {command}
      </code>
      <Button size="sm" variant="outline" onClick={() => void navigator.clipboard?.writeText(command).then(() => setCopied(true))}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/** Text the model will read, exactly as approved: never rendered as HTML or Markdown (React escapes it). */
const Verbatim = ({ children }: { children: string }) => <div className="whitespace-pre-wrap break-words rounded-chip bg-inset px-2 py-1 font-mono text-[12px] text-ink-2 shadow-hairline">{children}</div>;

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <h2 className="text-[13px] font-medium text-ink">{title}</h2>
      {children}
    </section>
  );
}

/** A Review panel: what will change, then Confirm or Cancel. Nothing is written until Confirm. */
function ReviewPanel({ lines, command, digest, onConfirm, onCancel, busy, confirmLabel = 'Confirm' }: { lines: string[]; command?: string | undefined; digest?: string | undefined; onConfirm: () => void; onCancel: () => void; busy: boolean; confirmLabel?: string }) {
  return (
    <div className="space-y-2 rounded-lg bg-blue-tint p-3" data-testid="plugin-review">
      <ul className="space-y-1 text-[12.5px] text-ink">
        {lines.map((l, i) => (
          <li key={i} className="break-words">
            {l}
          </li>
        ))}
      </ul>
      {digest && <div className="font-mono text-[11.5px] text-ink-2">Approval digest {digest}</div>}
      {command && <div className="text-[12px] text-ink-2">Confirm stages it. It is trusted for nothing until a root admin runs the command it then shows.</div>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy} onClick={onConfirm} data-testid="plugin-confirm">
          {busy ? 'Working…' : confirmLabel}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel} data-testid="plugin-cancel">
          Cancel
        </Button>
      </div>
    </div>
  );
}

function recordLines(r: Record<string, unknown> | undefined, current: { digest: string } | null | undefined): string[] {
  if (!r) return [];
  const out: string[] = [];
  if (current) out.push(`Replaces the approved ${String(r.id)} (${current.digest.slice(0, 19)}…): an update is a new approval`);
  if (r.kind === 'plugin') {
    const src = r.source as { url: string; sha: string; path?: string };
    const c = r.components as Record<string, string[]>;
    out.push(`${String(r.id)}: ${src.url}${src.path ? ` (${src.path})` : ''} at ${src.sha.slice(0, 12)}`);
    out.push(`Files ${String(r.tree)}`);
    for (const k of ['skills', 'agents', 'commands', 'bin'] as const) if (c[k]?.length) out.push(`${k}: ${c[k].join(', ')}`);
    for (const t of (r.transform as string[]) ?? []) out.push(`Changed: ${t}`);
  } else {
    const rt = r.runtime as { type: string; plugin?: string; server?: string; package?: string; version?: string; argv: string[] };
    out.push(`${String(r.id)}: ${rt.type === 'npm' ? `npm ${rt.package}@${rt.version}` : `${rt.plugin}'s server ${rt.server}`}, run by the broker in its own sandbox`);
    out.push(`Network: ${(r.network as string[]).join(', ') || 'none'}`);
    out.push(`Secrets: ${(r.secrets as string[]).join(', ') || 'none'} (names; values stay with the broker)`);
    const s = r.snapshot as { tools: { name: string }[] } | null;
    out.push(s ? `Tools: ${s.tools.map((t) => t.name).join(', ') || 'none'}` : 'Tools: none until a snapshot is approved');
  }
  out.push(`Roles: ${(r.roles as string[]).join(', ')}`);
  for (const f of (r.flags as string[]) ?? []) out.push(`Note: ${f}`);
  return out;
}

/** The empty state: what Plugins does, and its one action. */
function EmptyPlugins({ owner, onAdd }: { owner: boolean; onAdd: () => void }) {
  const [how, setHow] = useState(false);
  return (
    <div className="flex flex-col items-center gap-2 rounded-card bg-inset p-10 text-center shadow-hairline" data-testid="plugins-empty">
      <div className="text-[14px] font-medium text-ink">No plugins yet</div>
      <p className="max-w-md text-[12.5px] text-ink-2">
        {owner
          ? "Plugins give this instance's agents extra skills and tools, in Claude Code's own plugin format. You approve an exact version, see everything it can reach, and nothing updates on its own."
          : "Plugins give this instance's agents extra skills and tools. The instance's owners add them."}
      </p>
      {owner && (
        <>
          <Button onClick={onAdd} data-testid="plugins-add">
            Add a plugin
          </Button>
          <button type="button" className="text-[12px] text-blue-ink underline-offset-2 hover:underline" onClick={() => setHow(!how)} data-testid="plugins-how">
            How approval works ›
          </button>
          {how && (
            <ol className="max-w-md list-decimal space-y-1 pl-5 text-left text-[12px] text-ink-2">
              <li>Name a plugin by its git URL and an exact commit, or an MCP server by its npm package and exact version. The machine fetches it and shows you what it contains; nothing in it runs.</li>
              <li>Review the approval (its files, what it can reach, which roles get it), then Confirm to stage it.</li>
              <li>An admin runs the one root command the page shows, and types the id back. Agents get it from their next run.</li>
            </ol>
          )}
        </>
      )}
    </div>
  );
}

type AddKind = 'plugin' | 'npm';
function AddForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [kind, setKind] = useState<AddKind>('plugin');
  const [v, setV] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: string, x: string) => setV((o) => ({ ...o, [k]: x }));
  const input = (k: string, label: string, ph: string) => (
    <label className="flex flex-col gap-1 text-[12px] text-ink-2">
      {label}
      <input className={cx(field, 'w-full')} value={v[k] ?? ''} placeholder={ph} onChange={(e) => set(k, e.target.value.trim())} aria-label={label} data-testid={`plugin-add-${k}`} />
    </label>
  );
  const send = async () => {
    setBusy(true);
    try {
      await pluginAction('fetch', kind === 'plugin' ? { kind, id: v.id, url: v.url, sha: v.sha, ...(v.path ? { path: v.path } : {}) } : { kind, id: v.id, package: v.package, version: v.version });
      onDone();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-3 p-4" data-testid="plugins-add-form">
      <div className="flex flex-wrap gap-2 text-[12.5px]">
        {(['plugin', 'npm'] as const).map((k) => (
          <button key={k} type="button" onClick={() => setKind(k)} className={cx('rounded-full px-3 py-1', kind === k ? 'bg-ink text-surface' : 'bg-inset text-ink-2 shadow-hairline')}>
            {k === 'plugin' ? 'A plugin (git)' : 'An MCP server (npm)'}
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {input('id', 'Its id here', 'review-kit')}
        {kind === 'plugin' ? (
          <>
            {input('url', 'Git URL (https)', 'https://github.com/owner/repo.git')}
            {input('sha', 'Commit (all 40 characters)', '0123…')}
            {input('path', 'Subdirectory (optional)', 'plugins/review-kit')}
          </>
        ) : (
          <>
            {input('package', 'npm package', '@scope/server')}
            {input('version', 'Exact version', '1.4.2')}
          </>
        )}
      </div>
      <p className="text-[12px] text-ink-3">The machine fetches exactly this and shows you what it contains. Nothing is approved or run by fetching.</p>
      {msg && <div className="text-[12px] text-red">{msg}</div>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !v.id} onClick={() => void send()} data-testid="plugins-fetch">
          {busy ? 'Asking…' : 'Fetch a preview'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

/** One preview: what it contains, the choices an approval needs, and its Review then Confirm. */
function PreviewCard({ p, approved, onDone }: { p: PluginPreview; approved: PluginEntry | undefined; onDone: () => void }) {
  const ins = p.inspection;
  const refusals = p.kind === 'plugin' ? (ins?.refusals ?? []) : (p.refusals ?? []);
  const [roles, setRoles] = useState((approved?.record?.roles ?? ['builder']).join(', '));
  const [network, setNetwork] = useState(((approved?.record?.network as string[] | undefined) ?? p.snapshotNetwork ?? []).join(', '));
  const [secrets, setSecrets] = useState(((approved?.record?.secrets as string[] | undefined) ?? p.envNames ?? []).join(', '));
  const [review, setReview] = useState<PluginReview | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const split = (s: string) => s.split(/[\s,]+/).filter(Boolean);
  const body = () => ({ id: p.id, roles: split(roles), ...(p.kind === 'mcp' ? { network: split(network), secrets: split(secrets) } : {}) });
  const go = async (confirm: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await pluginAction('stage', { ...body(), ...(confirm ? { confirm: true, digest: review?.digest } : {}) });
      if (confirm) {
        setReview(null);
        onDone();
      } else setReview(r);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="space-y-2 p-4" data-testid="plugin-preview">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{p.id}</span>
        <Badge>{p.kind === 'plugin' ? 'plugin' : 'MCP server'}</Badge>
        {approved && <Badge tone="info">update</Badge>}
        {refusals.length ? <Badge tone="danger">refused</Badge> : <Badge tone="ok">passes inspection</Badge>}
        <span className="text-[12px] text-ink-3">fetched {ago(p.fetched_at)}</span>
      </div>
      {p.source && (
        <div className="break-all text-[12px] text-ink-2">
          {p.source.url}
          {p.source.path ? ` (${p.source.path})` : ''} at <span className="font-mono">{p.source.sha}</span>
        </div>
      )}
      {p.runtime && <div className="break-all text-[12px] text-ink-2">{p.runtime.type === 'npm' ? `npm ${p.runtime.package}@${p.runtime.version}` : `${p.runtime.plugin}'s server ${p.runtime.server}`}</div>}
      {refusals.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-red" data-testid="plugin-refusals">
          {refusals.map((r) => (
            <li key={r} className="break-words">
              {r}
            </li>
          ))}
        </ul>
      )}
      {ins && (
        <div className="text-[12px] text-ink-2">
          {[['skills', ins.skills], ['agents', ins.agents], ['commands', ins.commands], ['bin', ins.bin]].filter(([, l]) => (l as string[]).length).map(([k, l]) => `${k as string}: ${(l as string[]).join(', ')}`).join(' · ') || 'no components'} · {ins.files.length} files
          {ins.mcpServers.length > 0 && <div>MCP servers inside (each needs its own approval): {ins.mcpServers.map((s) => s.name).join(', ')}</div>}
        </div>
      )}
      {p.kind === 'mcp' && (
        <div className="space-y-1">
          {p.snapshot ? (
            <>
              <div className="text-[12px] text-ink-2">What the model will see{p.snapshotWithSecrets ? ' (taken with its secrets)' : ' (taken in quarantine: no secrets, no network)'}:</div>
              {p.snapshot.instructions && <Verbatim>{`instructions: ${p.snapshot.instructions}`}</Verbatim>}
              {p.snapshot.tools.map((t) => (
                <Verbatim key={t.name}>{`${t.name}: ${t.description ?? ''}\nschema: ${JSON.stringify(t.inputSchema)}`}</Verbatim>
              ))}
            </>
          ) : (
            <div className="text-[12px] text-orange">No snapshot: {p.snapshotError}. Approve it without tools, install its secrets, then take the snapshot with them (a second approval).</div>
          )}
        </div>
      )}
      {[...(ins?.flags ?? []), ...(p.flags ?? [])].length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-orange" data-testid="plugin-flags">
          {[...(ins?.flags ?? []), ...(p.flags ?? [])].map((f) => (
            <li key={f} className="break-words">
              {f}
            </li>
          ))}
        </ul>
      )}
      {!refusals.length && (
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-[12px] text-ink-2">
            Roles that get it
            <input className={field} value={roles} onChange={(e) => (setRoles(e.target.value), setReview(null))} aria-label="roles" />
          </label>
          {p.kind === 'mcp' && (
            <>
              <label className="flex flex-col gap-1 text-[12px] text-ink-2">
                Hosts it may reach
                <input className={field} value={network} placeholder="none" onChange={(e) => (setNetwork(e.target.value), setReview(null))} aria-label="network" />
              </label>
              <label className="flex flex-col gap-1 text-[12px] text-ink-2">
                Its secrets (names)
                <input className={field} value={secrets} placeholder="none" onChange={(e) => (setSecrets(e.target.value), setReview(null))} aria-label="secrets" />
              </label>
            </>
          )}
        </div>
      )}
      {msg && <div className="text-[12px] text-red">{msg}</div>}
      {!refusals.length &&
        (review ? (
          <ReviewPanel lines={recordLines(review.record, review.current)} command={review.command} digest={review.digest} busy={busy} onConfirm={() => void go(true)} onCancel={() => setReview(null)} />
        ) : (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void go(false)} data-testid="plugin-review-button">
            {approved ? 'Review the update' : 'Review the approval'}
          </Button>
        ))}
    </Card>
  );
}

/** One approved entry: what it reaches, and its owner actions (each Review then Confirm). */
function EntryRow({ e, owner, onDone }: { e: PluginEntry; owner: boolean; onDone: () => void }) {
  const [review, setReview] = useState<{ action: 'toggle' | 'remove'; lines: string[]; body: Record<string, unknown> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const ask = async (action: 'toggle' | 'remove', body: Record<string, unknown>, confirm: boolean) => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await pluginAction(action, { ...body, ...(confirm ? { confirm: true } : {}) });
      if (confirm) {
        setReview(null);
        onDone();
      } else setReview({ action, lines: r.changes ?? [], body });
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const fetchMore = async (body: Record<string, unknown>) => {
    try {
      await pluginAction('fetch', body);
      onDone();
    } catch (err) {
      setMsg((err as Error).message);
    }
  };
  const servers = e.kind === 'plugin' ? ((e.record?.mcpServers as { name: string }[] | undefined) ?? []) : [];
  const noSnapshot = e.kind === 'mcp' && e.record && e.record.snapshot === null;
  return (
    <div className="space-y-2 p-4" data-testid="plugin-entry">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{e.id}</span>
        <Badge>{e.kind === 'plugin' ? 'plugin' : 'MCP server'}</Badge>
        <Badge tone={e.on ? 'ok' : 'neutral'}>{e.on ? 'on' : 'off'}</Badge>
        <span className="min-w-0 break-all text-[12px] text-ink-3">{e.label}</span>
      </div>
      <ul className="space-y-0.5 text-[12px] text-ink-2">
        {e.reach.map((r) => (
          <li key={r} className="break-words">
            {r}
          </li>
        ))}
        <li>Roles: {(e.roles ?? (e.record?.roles as string[] | undefined) ?? []).join(', ')}</li>
        {e.confirmed_at && (
          <li className="text-ink-3">
            Approved {ago(e.confirmed_at)} (staged by {e.staged_by})
          </li>
        )}
      </ul>
      {msg && <div className="text-[12px] text-red">{msg}</div>}
      {owner &&
        (review ? (
          <ReviewPanel lines={review.lines} busy={busy} confirmLabel={review.action === 'remove' ? 'Remove' : 'Confirm'} onConfirm={() => void ask(review.action, review.body, true)} onCancel={() => setReview(null)} />
        ) : (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void ask('toggle', { id: e.id, on: !e.on }, false)} data-testid="plugin-toggle">
              {e.on ? 'Disable' : 'Enable'}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void ask('remove', { id: e.id }, false)} data-testid="plugin-remove">
              Remove
            </Button>
            {servers.map((s) => (
              <Button key={s.name} size="sm" variant="outline" onClick={() => void fetchMore({ kind: 'server', id: `${e.id}-${s.name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(0, 40), plugin: e.id, server: s.name })}>
                Allowlist its MCP server {s.name}
              </Button>
            ))}
            {noSnapshot && (
              <Button size="sm" variant="outline" onClick={() => void fetchMore({ kind: 'snapshot', id: e.id })}>
                Take its snapshot with its secrets
              </Button>
            )}
          </div>
        ))}
    </div>
  );
}

export function ExtendPage({ state, path }: { state: State; path: string }) {
  const owner = state.role === 'owner';
  const [view, setView] = useState<PluginsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const load = useCallback(() => {
    getPlugins().then(
      (v) => (setView(v), setError(null)),
      (e: Error) => setError(e.message),
    );
  }, []);
  useEffect(() => {
    if (path === '/extend') navigate('/extend/plugins');
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load, path]);
  const entries = view?.entries ?? [];
  const previews = (view?.previews ?? []).filter((p) => !view?.pending?.some((x) => x.id === p.id));
  const empty = view?.available && !entries.length && !previews.length && !(view.pending ?? []).length;
  return (
    <div data-testid="page-extend">
      <Header title="Extend" sub="what this instance's agents may use beyond the repo" />
      <div className="space-y-5 px-6 py-5 max-md:px-4">
        <nav className="flex gap-1" aria-label="Extend">
          {TABS.map((t) => (
            <button key={t.to} type="button" className={cx('rounded-full px-3 py-1 text-[12.5px]', path.startsWith(t.to) || path === '/extend' ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-hover-2')} onClick={() => navigate(t.to)} data-testid="extend-tab">
              {t.label}
            </button>
          ))}
        </nav>
        {error && <div className="text-[12.5px] text-red">{error}</div>}
        {!view && !error && <div className="text-[12.5px] text-ink-3">Loading…</div>}
        {view && !view.available && <div className="text-[12.5px] text-ink-3">{view.why}</div>}
        {view?.problem && <div className="rounded-card bg-red-tint px-3 py-2 text-[12.5px] text-red">{view.problem}</div>}
        {view?.offProblem && <div className="rounded-card bg-orange-tint px-3 py-2 text-[12.5px] text-orange">{view.offProblem}</div>}
        {!owner && view?.available && <div className="text-[12.5px] text-ink-3" data-testid="plugins-writer-note">The instance's owners add and change plugins.{view.waiting ? ` ${view.waiting} waiting for an owner.` : ''}</div>}
        {empty && !adding && <EmptyPlugins owner={owner} onAdd={() => setAdding(true)} />}
        {owner && view?.available && !empty && !adding && (
          <Button size="sm" onClick={() => setAdding(true)} data-testid="plugins-add">
            Add a plugin
          </Button>
        )}
        {adding && <AddForm onDone={() => (setAdding(false), load())} onCancel={() => setAdding(false)} />}
        {owner && view?.fetchStatus && view.fetchStatus.state !== 'done' && (
          <div className={cx('text-[12.5px]', view.fetchStatus.state === 'failed' ? 'text-red' : 'text-ink-2')} data-testid="plugins-fetch-status">
            {view.fetchStatus.state === 'running' ? `Fetching ${view.fetchStatus.id}…` : `Fetch of ${view.fetchStatus.id} failed: ${view.fetchStatus.reason}`}
          </div>
        )}
        {owner && view?.blocked && Object.keys(view.blocked).length > 0 && (
          <Section title="Blocked: tools changed after approval" testId="plugins-blocked">
            {Object.entries(view.blocked).map(([id, b]) => (
              <div key={id} className="rounded-card bg-red-tint px-3 py-2 text-[12.5px] text-red">
                {id}, {ago(b.at)}: {[b.diff.added.length ? `added ${b.diff.added.join(', ')}` : '', b.diff.removed.length ? `removed ${b.diff.removed.join(', ')}` : '', ...b.diff.changed.map((c) => `${c.name} changed its ${c.fields.join(', ')}`), b.diff.instructions ? 'instructions changed' : ''].filter(Boolean).join('; ')}. Its servers serve nothing until you approve a new snapshot or remove it.
              </div>
            ))}
          </Section>
        )}
        {owner && (view?.pending ?? []).length > 0 && (
          <Section title="Waiting for the machine step" testId="plugins-pending">
            {view!.pending!.map((p) => (
              <Card key={p.id} className="space-y-2 p-4">
                <div className="text-[12.5px] text-ink">
                  {p.id}: staged {ago(p.staged_at)} by {p.staged_by}. Run as root on the machine, then type the id back when it asks:
                </div>
                <CommandLine command={p.command} />
                <Button size="sm" variant="ghost" onClick={() => void pluginAction('withdraw', { id: p.id }).then(load)}>
                  Withdraw
                </Button>
              </Card>
            ))}
          </Section>
        )}
        {owner && previews.length > 0 && (
          <Section title="To review" testId="plugins-previews">
            {previews.map((p) => (
              <PreviewCard key={p.id} p={p} approved={entries.find((e) => e.id === p.id)} onDone={load} />
            ))}
          </Section>
        )}
        {entries.length > 0 && (
          <Section title="Allowed for agents" testId="plugins-allowed">
            <Card className="divide-y divide-line">
              {entries.map((e) => (
                <EntryRow key={e.id} e={e} owner={owner} onDone={load} />
              ))}
            </Card>
          </Section>
        )}
        {owner && (view?.audit ?? []).length > 0 && (
          <details className="text-[12px] text-ink-2" data-testid="plugins-audit">
            <summary className="cursor-pointer text-[13px] font-medium text-ink">Approvals (audit)</summary>
            <ul className="mt-2 space-y-1">
              {[...view!.audit!].reverse().map((a, i) => (
                <li key={i} className="break-words">
                  {ago(a.at)} · {a.root ? `root (${a.by})` : a.login} · {a.action}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </div>
  );
}
