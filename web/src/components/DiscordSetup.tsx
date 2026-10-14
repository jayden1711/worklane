// The first-run page's Discord step (wizard screen 11; src/intake/discord-setup.ts): the bot token through the setup
// console's paste box, the invite link with exactly the permissions intake needs, the server and channels picked
// from the bot's own list, and intake.yaml written only after the exact diff is shown and an owner confirms it.
// The token never reaches this page: the list comes from a child process on the instance that reads it itself.
// Closing the step without confirming changes nothing.
import { useCallback, useEffect, useState } from 'react';
import { changeDiscordIntake, getDiscordBot, getDiscordSetup, openDiscordTokenAsk, type DiscordBot, type DiscordChannel, type DiscordFormValue, type DiscordIntakePlan, type DiscordSetup } from '../api';
import { AskCard } from '../pages/Setup';
import { ago, Badge, Button, cx } from './ui';

const code = 'block overflow-x-auto whitespace-pre rounded-lg bg-surface px-3 py-2 font-mono text-[12px] text-ink shadow-hairline';
const field = 'h-8 min-w-0 max-w-full rounded-control bg-field px-2 text-[12.5px] text-ink shadow-hairline outline-none focus:shadow-[0_0_0_1px_var(--blue)]';

type Ready = Extract<DiscordSetup, { available: true }>;
type Values = Record<string, DiscordFormValue>;

const LABEL: Record<string, string> = {
  'discord.enabled': 'Connect the bot',
  'discord.guild': 'Server',
  'discord.channels': 'Report and idea channels',
  'discord.asks_channel': 'Asks channel',
  'discord.ops_channel': 'Ops channel',
  'discord.chat_channels': 'Chat channels',
  'discord.dashboard_url': 'Dashboard address',
  'superfan.enabled': 'Turn the superfan on',
  'superfan.channel': 'Superfan channel',
  'superfan.machine_channel': 'Engine and updater channel',
};
/** Channels the bot reads: offered from the chosen server only (the server refuses any other). */
const IN_SERVER = new Set(['discord.channels', 'discord.asks_channel', 'discord.chat_channels']);

function Step({ n, title, children, testid }: { n: number; title: string; children: React.ReactNode; testid: string }) {
  return (
    <li className="space-y-2" data-testid={testid}>
      <div className="flex items-center gap-2 text-[13px] font-medium text-ink">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface text-[11px] text-ink-2 shadow-hairline" aria-hidden>
          {n}
        </span>
        {title}
      </div>
      <div className="space-y-2 sm:pl-7">{children}</div>
    </li>
  );
}

/** One of the form's keys: a toggle, a channel or server picker, a set of channels, or the dashboard's address. */
function Field({ f, value, bot, guild, disabled, onChange }: { f: Ready['form'][number]; value: DiscordFormValue; bot: DiscordBot; guild: string | null; disabled: boolean; onChange: (v: DiscordFormValue) => void }) {
  const label = LABEL[f.key] ?? f.key;
  const guilds = [...new Map(bot.channels.map((c) => [c.guild_id, c.guild])).entries()];
  const offered: DiscordChannel[] = IN_SERVER.has(f.key) ? bot.channels.filter((c) => c.guild_id === guild) : bot.channels;
  const name = (c: DiscordChannel) => (IN_SERVER.has(f.key) ? `#${c.name}` : `${c.guild} / #${c.name}`);
  let control: React.ReactNode;
  if (f.kind === 'boolean') {
    control = <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} className="h-4 w-4" data-testid="discord-field-input" />;
  } else if (f.kind === 'url') {
    control = <input type="url" value={typeof value === 'string' ? value : ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} placeholder="https://…" aria-label={label} spellCheck={false} className={cx(field, 'w-72')} data-testid="discord-field-input" />;
  } else if (f.kind === 'ids') {
    const picked = Array.isArray(value) ? value : [];
    // WHY: an id already in the file that the bot can't see now stays shown, so unticking it is a visible choice.
    const unseen = picked.filter((id) => !offered.some((c) => c.id === id));
    control = (
      <div className="flex flex-wrap gap-x-3 gap-y-1.5" role="group" aria-label={label} data-testid="discord-field-input">
        {!offered.length && !unseen.length && <span className="text-[12px] text-ink-3">{guild ? 'the bot sees no text channel in this server' : 'pick the server first'}</span>}
        {[...offered.map((c) => ({ id: c.id, text: name(c) })), ...unseen.map((id) => ({ id, text: `${id} (not in the bot's list)` }))].map((c) => (
          <label key={c.id} className="inline-flex min-h-6 items-center gap-1.5 text-[12.5px] text-ink">
            <input type="checkbox" checked={picked.includes(c.id)} disabled={disabled} onChange={(e) => onChange(e.target.checked ? [...picked, c.id] : picked.filter((x) => x !== c.id))} className="h-4 w-4" />
            {c.text}
          </label>
        ))}
      </div>
    );
  } else {
    const current = typeof value === 'string' ? value : '';
    const options = f.kind === 'guild' ? guilds.map(([id, text]) => ({ id, text })) : offered.map((c) => ({ id: c.id, text: name(c) }));
    control = (
      <select value={current} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} aria-label={label} className={cx(field, 'w-72')} data-testid="discord-field-input">
        <option value="">{f.kind === 'guild' ? 'no server' : 'none'}</option>
        {current && !options.some((o) => o.id === current) && <option value={current}>{current} (not in the bot's list)</option>}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.text}
          </option>
        ))}
      </select>
    );
  }
  return (
    <div className="grid gap-1 sm:grid-cols-[11rem_1fr] sm:gap-3" data-testid="discord-field" data-key={f.key}>
      <div className="text-[12.5px] font-medium text-ink">
        {label}
        <div className="font-mono text-[11px] font-normal text-ink-3">{f.key}</div>
      </div>
      <div className="min-w-0 space-y-1">
        {control}
        <p className="text-[12px] text-ink-3">{f.what}</p>
      </div>
    </div>
  );
}

export interface DiscordSetupViewProps {
  v: DiscordSetup;
  bot?: DiscordBot | null;
  botError?: string | null;
  loadingBot?: boolean;
  onLoadBot?: (fresh: boolean) => void;
  /** Something changed on the server (a token stored, intake.yaml written): read the step again. */
  onChanged?: () => void;
  /** For the render checks: the state a click would have reached. */
  initialTokenConfirming?: boolean;
  initialPlan?: DiscordIntakePlan | null;
  initialValues?: Values;
}

/** The step from its data (also what the render checks render). */
export function DiscordSetupView({ v, bot = null, botError = null, loadingBot = false, onLoadBot, onChanged, initialTokenConfirming = false, initialPlan = null, initialValues }: DiscordSetupViewProps) {
  const [tokenConfirming, setTokenConfirming] = useState(initialTokenConfirming);
  const [values, setValues] = useState<Values>(initialValues ?? (v.available ? v.intake.values : {}));
  const [plan, setPlan] = useState<DiscordIntakePlan | null>(initialPlan);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!v.available)
    return (
      <p className="text-[12.5px] text-ink-2" data-testid="discord-setup-unavailable">
        {v.why}.
      </p>
    );
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const set = (key: string, value: DiscordFormValue) => {
    // A reviewed change is for the picks as they were: any new pick needs a new review.
    setPlan(null);
    setMsg(null);
    setValues((old) => ({ ...old, [key]: value }));
  };
  const guild = typeof values['discord.guild'] === 'string' ? (values['discord.guild'] as string) : null;
  const stored = v.token.configured && v.token.present;
  return (
    <div className="space-y-4" data-testid="discord-setup" data-instance={v.instance}>
      <p className="text-[12.5px] text-ink-2">
        Optional. Nothing here changes until you confirm it: closing this step leaves the token, the bot and <code>intake.yaml</code> as they are, and Discord stays off until <code>intake.yaml</code> turns it on.
      </p>
      {!v.canAct && (
        <p className="text-[12.5px] text-ink-3" data-testid="discord-setup-refused">
          Only the instance's owners can set up its bot. You can read where it stands.
        </p>
      )}
      <ol className="space-y-4">
        <Step n={1} title="Create the bot, in Discord's developer portal" testid="discord-step-portal">
          <p className="text-[12.5px] text-ink-2">
            Only there: New Application, then Bot. On the Bot page turn on <span className="font-medium text-ink">Message Content Intent</span> (without it the bot reads no message text), and use Reset Token to get the token for the next step.
          </p>
          <a href={v.portal} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center rounded-full bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90" data-testid="discord-portal-link">
            Open Discord's developer portal
          </a>
        </Step>
        <Step n={2} title="Store the bot token" testid="discord-step-token">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-2" data-testid="discord-token-state" data-stored={stored}>
            <Badge tone={stored ? 'ok' : 'neutral'}>{stored ? 'stored' : 'not stored'}</Badge>
            {v.token.error ? (
              <span className="text-red">{v.token.error}</span>
            ) : v.token.file ? (
              <span className="break-all">
                <code>{v.token.file}</code>
                {v.token.present ? ', readable only by this instance’s coordinator user' : ': credentials.yaml names it, but no file is there'}
              </span>
            ) : (
              <span>credentials.yaml names no bot token yet</span>
            )}
          </div>
          <p className="text-[12px] text-ink-3">The token is pasted once, goes straight to that file (0400) and is never shown again: not on this page, in a log, an event or Discord.</p>
          {v.ask ? (
            <AskCard a={v.ask} {...(onChanged ? { onChanged } : {})} />
          ) : !v.canAct ? null : !tokenConfirming ? (
            <Button size="sm" variant={stored ? 'outline' : 'default'} onClick={() => setTokenConfirming(true)} data-testid="discord-token-button">
              {stored ? 'Replace the token…' : 'Paste the token…'}
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2 rounded-lg bg-blue-tint p-3" data-testid="discord-token-confirming">
              <span className="text-[12.5px] text-ink">Open a paste box for the token? It records an ask in this instance's log (never the token).</span>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await openDiscordTokenAsk();
                    setTokenConfirming(false);
                    onChanged?.();
                  })
                }
                data-testid="discord-token-confirm"
              >
                {busy ? 'Opening…' : 'Confirm'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setTokenConfirming(false)} data-testid="discord-token-cancel">
                Cancel
              </Button>
            </div>
          )}
        </Step>
        <Step n={3} title="Invite the bot to your server" testid="discord-step-invite">
          <p className="text-[12.5px] text-ink-2">
            The link asks for exactly these permissions (integer <code data-testid="discord-invite-integer">{v.invite.integer}</code>) and nothing else:
          </p>
          <ul className="space-y-0.5 text-[12.5px] text-ink-2" data-testid="discord-invite-permissions">
            {v.invite.permissions.map((p) => (
              <li key={p.bit}>
                <span className="font-medium text-ink">{p.name}</span>: {p.why}
              </li>
            ))}
          </ul>
          {bot ? (
            <div className="space-y-2">
              <a href={bot.invite} target="_blank" rel="noreferrer" className="inline-flex h-7 items-center rounded-full bg-ink px-3 text-[12.5px] font-medium text-surface hover:opacity-90" data-testid="discord-invite-link">
                Open Discord's invite page for {bot.application.name || 'the bot'}
              </a>
              <code className={code}>{bot.invite}</code>
              <p className="text-[12.5px] text-ink-2" data-testid="discord-intent" data-on={bot.application.message_content}>
                Message Content Intent: {bot.application.message_content ? 'on' : <span className="text-red">off. Turn it on in the portal's Bot page, or the bot reads no message text.</span>}
              </p>
            </div>
          ) : (
            <p className="text-[12px] text-ink-3" data-testid="discord-invite-waiting">
              The link needs the bot's own id: {stored ? "load the bot's view below." : 'store the token first.'}
            </p>
          )}
        </Step>
        <Step n={4} title="Pick the server and channels, from the bot's own list" testid="discord-step-channels">
          <div className="flex flex-wrap items-center gap-2">
            {v.canAct && stored && (
              <Button size="sm" variant={bot ? 'outline' : 'default'} disabled={loadingBot} onClick={() => onLoadBot?.(!!bot)} data-testid="discord-load">
                {loadingBot ? 'Asking Discord…' : bot ? 'Load it again' : "Load the bot's view"}
              </Button>
            )}
            {bot && (
              <span className="text-[12px] text-ink-3" data-testid="discord-loaded">
                {bot.channels.length} channel{bot.channels.length === 1 ? '' : 's'} the bot can see, read {ago(bot.at)}
              </span>
            )}
          </div>
          <p className="text-[12px] text-ink-3">The instance asks Discord as its own user (read-only) and sends back names and ids only. A channel the bot can't see yet shows up after the invite, or once its role may view that channel.</p>
          {botError && (
            <p className="break-words text-[12.5px] text-red" data-testid="discord-load-error">
              {botError}
            </p>
          )}
          {v.intake.error && (
            <p className="break-words text-[12.5px] text-red" data-testid="discord-intake-error">
              {v.intake.error}
            </p>
          )}
          {bot && !v.intake.error && (
            <div className="space-y-3 rounded-lg bg-surface p-3 shadow-hairline" data-testid="discord-form">
              {v.form.map((f) => (
                <Field key={f.key} f={f} value={values[f.key] ?? null} bot={bot} guild={guild} disabled={!v.canAct || busy} onChange={(x) => set(f.key, x)} />
              ))}
              <p className="text-[12px] text-ink-3">
                Who may send (<code>discord.allowed_senders</code>), who is who (<code>discord.people</code>), the owners and the trusted senders stay in <code>{v.intake.file}</code> by hand: this step writes only the keys above and keeps every other key and comment.
              </p>
              {v.canAct && !plan && (
                <Button size="sm" disabled={busy} onClick={() => void run(async () => setPlan(await changeDiscordIntake(values)))} data-testid="discord-review">
                  {busy ? 'Checking…' : 'Review the change'}
                </Button>
              )}
              {plan && !plan.confirmed && (
                <div className="space-y-2" data-testid="discord-plan">
                  <p className="text-[12.5px] text-ink">{plan.creates ? `This creates ${plan.file} (0600):` : `This changes ${plan.file}:`}</p>
                  <pre className={cx(code, 'max-h-96')} data-testid="discord-diff">
                    {plan.diff}
                  </pre>
                  {plan.warnings.map((w) => (
                    <p key={w} className="text-[12.5px] text-orange" data-testid="discord-warning">
                      {w}
                    </p>
                  ))}
                  <div className="flex flex-wrap items-center gap-2 rounded-lg bg-blue-tint p-3" data-testid="discord-confirming">
                    <span className="text-[12.5px] text-ink">Write exactly this change?</span>
                    <Button
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const done = await changeDiscordIntake(values, plan.hash);
                          setPlan(null);
                          setMsg({ ok: true, text: `Wrote ${done.file}. The server and channels the bot connects with take effect when the instance restarts.` });
                          onChanged?.();
                        })
                      }
                      data-testid="discord-confirm"
                    >
                      {busy ? 'Writing…' : 'Confirm and write'}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPlan(null)} data-testid="discord-cancel">
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
          {v.intake.warnings.map((w) => (
            <p key={w} className="text-[12.5px] text-orange" data-testid="discord-warning">
              {w}
            </p>
          ))}
        </Step>
      </ol>
      {msg && (
        <p className={cx('break-words text-[12.5px]', msg.ok ? 'text-green' : 'text-red')} data-testid="discord-result">
          {msg.text}
        </p>
      )}
      <div className="space-y-1.5" data-testid="discord-automation">
        <div className="text-[12.5px] font-medium text-ink">The same without this page</div>
        <p className="text-[12px] text-ink-3">The token, as root (a hidden prompt, or the token on stdin); the bot's channels, as the instance's user; then these keys in {v.automation.file} (0600); then restart.</p>
        <code className={code}>{[v.automation.token, v.automation.channels, `# intake.yaml: ${v.automation.keys.join(', ')}`, v.automation.restart].join('\n')}</code>
      </div>
    </div>
  );
}

/** The step, live: its state from the instance, and the bot's view when an owner asks for it. */
export function DiscordSetupPanel({ onChanged }: { onChanged?: () => void }) {
  const [v, setV] = useState<DiscordSetup | { error: string } | null>(null);
  const [bot, setBot] = useState<DiscordBot | null>(null);
  const [botError, setBotError] = useState<string | null>(null);
  const [loadingBot, setLoadingBot] = useState(false);
  const load = useCallback(() => {
    getDiscordSetup()
      .then(setV)
      .catch((e: Error) => setV({ error: e.message }));
  }, []);
  useEffect(load, [load]);
  const loadBot = (fresh: boolean) => {
    setLoadingBot(true);
    setBotError(null);
    getDiscordBot(fresh)
      .then(setBot)
      .catch((e: Error) => setBotError(e.message))
      .finally(() => setLoadingBot(false));
  };
  if (!v) return <p className="text-[12.5px] text-ink-3">Loading…</p>;
  if ('error' in v) return <p className="text-[12.5px] text-red">Can't load the Discord step: {v.error}</p>;
  return (
    <DiscordSetupView
      v={v}
      bot={bot}
      botError={botError}
      loadingBot={loadingBot}
      onLoadBot={loadBot}
      onChanged={() => {
        load();
        onChanged?.();
      }}
    />
  );
}
