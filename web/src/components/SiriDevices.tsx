// Settings, Siri devices (docs/siri.md): each phone's token, when it was last used and from which Tailscale device,
// and Revoke. Owners make a token here (shown once, never again) from an allowed console device; writers see the list.
import { useEffect, useId, useState } from 'react';
import { api, useView } from '../api';
import { ago, Badge, Button, Card, Why, firstWhy } from './ui';

export interface SiriDevice {
  id: string;
  name: string;
  created: string;
  createdBy: string;
  boundNode: string | null;
  lastUsed: string | null;
  lastNode: string | null;
  lastForeign: { at: string; node: string } | null;
  state: 'active' | 'revoked' | 'expired';
  revokedAt: string | null;
}

export interface SiriDevicesView {
  enabled: boolean;
  server: boolean;
  owner: boolean;
  createRefused: string | null;
  devices: SiriDevice[];
}

const TONE = { active: 'ok', revoked: 'neutral', expired: 'warn' } as const;

/** The list and its controls, as rendered (the page passes the server's view and the handlers). */
export function SiriDevicesCard({ view, made, error, busy, onCreate, onRevoke, onUnbind, onDismiss }: { view: SiriDevicesView; made: { name: string; token: string } | null; error: string | null; busy: boolean; onCreate: (name: string) => void; onRevoke: (id: string) => void; onUnbind: (id: string) => void; onDismiss: () => void }) {
  const [name, setName] = useState('');
  // The server's reason (said once, under the form) holds Unbind and New token alike.
  const [refusedId, busyId] = [useId(), useId()];
  const held = (more?: string | false) => ({ why: firstWhy(view.createRefused, busy && 'Saving…', more), ...(view.createRefused ? { whyAt: refusedId } : busy ? { whyAt: busyId } : {}) });
  return (
    <Card className="overflow-hidden" data-testid="settings-siri">
      <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Siri devices</div>
      <div className="space-y-2 px-4 py-3 text-[12.5px] text-ink-2">
        <p>
          "Hey Siri, tell" leaves an idea in the Inbox for approval; "Hey Siri, ask" answers aloud from what a viewer may see. A device token can do nothing else. See docs/siri.md for the Shortcuts.
        </p>
        {!view.enabled && (
          <p className="text-ink-3" data-testid="siri-off">
            Off for this instance: set siri.enabled in its intake.yaml.
          </p>
        )}
      </div>
      {made && (
        <div className="border-t border-line bg-inset px-4 py-3 text-[12.5px]" data-testid="siri-token-once">
          <p className="font-medium text-ink">The token for {made.name}. It is shown once: put it in the Shortcut now.</p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface p-2 font-mono text-[12px] text-ink" data-testid="siri-token">
            {made.token}
          </pre>
          <div className="mt-2 flex gap-2">
            <Button onClick={() => void navigator.clipboard?.writeText(made.token)} data-testid="siri-token-copy">
              Copy
            </Button>
            <Button onClick={onDismiss} data-testid="siri-token-done">
              Done
            </Button>
          </div>
        </div>
      )}
      {view.devices.length ? (
        <ul className="divide-y divide-line border-t border-line">
          {view.devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px]" data-testid="siri-device" data-state={d.state}>
              <span className="font-medium text-ink">{d.name}</span>
              <Badge tone={TONE[d.state]}>{d.state}</Badge>
              <span className="text-[12px] text-ink-3">
                {d.boundNode ? `bound to ${d.boundNode}` : 'not used yet'} · {d.lastUsed ? `last used ${ago(d.lastUsed)}` : 'never used'} · made by @{d.createdBy}
              </span>
              {d.lastForeign && (
                <span className="basis-full text-[12px] text-orange" data-testid="siri-foreign">
                  refused from another device, {d.lastForeign.node}, {ago(d.lastForeign.at)}
                </span>
              )}
              {view.owner && d.state !== 'revoked' && (
                <span className="ml-auto flex gap-2">
                  {d.boundNode && (
                    <Button {...held()} onClick={() => onUnbind(d.id)} data-testid="siri-unbind">
                      Unbind
                    </Button>
                  )}
                  <Button why={busy && 'Saving…'} whyAt={busyId} onClick={() => onRevoke(d.id)} data-testid="siri-revoke">
                    Revoke
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="border-t border-line px-4 py-2 text-[12.5px] text-ink-3">No Siri devices.</p>
      )}
      {view.owner && (
        <form
          className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) onCreate(name.trim());
          }}
        >
          <input className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1.5 text-[13px]" placeholder="This phone's name" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} disabled={busy || !!view.createRefused} data-testid="siri-name" />
          <Button type="submit" {...held(!name.trim() && "Name this phone first")} data-testid="siri-create">
            New token
          </Button>
          {view.createRefused && (
            <span id={refusedId} className="basis-full text-[12px] text-ink-3" data-testid="siri-create-refused">
              {view.createRefused}
            </span>
          )}
        </form>
      )}
      {busy && (
        <p className="border-t border-line px-4 py-2">
          <Why id={busyId}>Saving…</Why>
        </p>
      )}
      {error && (
        <p className="border-t border-line px-4 py-2 text-[12.5px] text-red" data-testid="siri-error">
          {error}
        </p>
      )}
    </Card>
  );
}

/**
 * Settings' Siri devices card: shown to the owners and writers of a server instance. `onLoaded`: called once its first
 * answer (the view, or an error) is in, for the page's in-order loading (#455).
 */
export function SiriDevices({ onLoaded }: { onLoaded?: () => void } = {}) {
  const [dep, setDep] = useState(0);
  const { data, error: loadError } = useView<SiriDevicesView>('/api/siri-devices', dep);
  useEffect(() => {
    if (data || loadError) onLoaded?.();
  }, [data, loadError, onLoaded]);
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data || !data.server) return null;
  const act = async (path: string, body: object, then?: (r: unknown) => void) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<unknown>(path, { method: 'POST', body: JSON.stringify(body) });
      then?.(r);
      setDep((x) => x + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <SiriDevicesCard
      view={data}
      made={made}
      error={error}
      busy={busy}
      onCreate={(name) => void act('/api/siri-devices', { name }, (r) => setMade({ name, token: (r as { token: string }).token }))}
      onRevoke={(id) => void act(`/api/siri-devices/${id}/revoke`, {})}
      onUnbind={(id) => void act(`/api/siri-devices/${id}/unbind`, {})}
      onDismiss={() => setMade(null)}
    />
  );
}
