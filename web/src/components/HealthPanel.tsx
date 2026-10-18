// Machine health (GET /api/health): the OS adapter's snapshot of memory, swap,
// load and disk; the harness slice's and this instance's service's use; how
// long each check takes and which got slower; what the runs used per day; and
// suggestions. On a hub, each instance's service and today's usage side by side.
import { useEffect, useState } from 'react';
import { api, hub, instanceScope, onInstance, type HealthView } from '../api';
import { DotPill, Meter, RecordsTable } from './patterns';
import { ago, Badge, Card, cx, EST_NOTE, estUsd } from './ui';

type Machine = NonNullable<HealthView['machine']>;
type Unit = NonNullable<Machine['units']>[number];
type OkUnit = Extract<Unit, { memoryCurrent: unknown }>;

const gb = (b: number) => `${(b / 1e9).toFixed(1)} GB`;
const dur = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);
const cpu = (ns: number) => {
  const s = ns / 1e9;
  return s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
};
const isOk = (u: Unit): u is OkUnit => !('error' in u);
/** Paths on the same volume (same size and free space) shown once, naming every path. */
function disksOnce(disks: Machine['disks']): Machine['disks'] {
  const out: Machine['disks'] = [];
  for (const d of disks) {
    const same = 'error' in d ? undefined : out.find((x) => !('error' in x) && x.totalBytes === d.totalBytes && x.freeBytes === d.freeBytes);
    if (same) same.path = `${same.path}, ${d.path}`;
    else out.push({ ...d });
  }
  return out;
}
const NOTHING = /^Nothing to suggest/;

/** A bar with a label: how much of a whole is used; tinted only past the thresholds the suggestions use. */
function Usage({ used, total, warnAt, label }: { used: number; total: number; warnAt: number; label: string }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-hover-2" role="progressbar" aria-label={label} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={cx('h-full rounded-full', pct >= warnAt ? 'bg-orange' : 'bg-blue')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function Figure({ label, value, hint, children, testId }: { label: string; value: string; hint?: string; children?: React.ReactNode; testId: string }) {
  return (
    <div className="rounded-card bg-surface p-3 shadow-card" data-testid={testId}>
      <div className="text-[12px] font-medium text-ink-3">{label}</div>
      <div className="mt-1 text-[18px] font-semibold tracking-tight tabular-nums text-ink">{value}</div>
      {hint && <div className="mt-0.5 truncate text-[12px] text-ink-3">{hint}</div>}
      {children}
    </div>
  );
}

/** A check's durations over its recent runs: one 2px line in ink, each point titled with its value (hover). */
export function Sparkline({ series }: { series: { at: string; ms: number; status: string }[] }) {
  const w = 120;
  const h = 26;
  if (series.length < 2) return <span className="text-[11.5px] text-ink-3">–</span>;
  const max = Math.max(...series.map((p) => p.ms));
  const min = Math.min(...series.map((p) => p.ms));
  const x = (i: number) => 3 + (i / (series.length - 1)) * (w - 6);
  const y = (ms: number) => (max === min ? h / 2 : h - 3 - ((ms - min) / (max - min)) * (h - 6));
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`${series.length} recent runs, ${dur(min)} to ${dur(max)}`} data-testid="health-sparkline">
      <polyline points={series.map((p, i) => `${x(i)},${y(p.ms)}`).join(' ')} fill="none" stroke="var(--ink-2)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      {series.map((p, i) => (
        <circle key={i} cx={x(i)} cy={y(p.ms)} r={i === series.length - 1 ? 3 : 6} fill={i === series.length - 1 ? 'var(--ink)' : 'transparent'}>
          <title>{`${new Date(p.at).toLocaleString()}: ${dur(p.ms)} (${p.status})`}</title>
        </circle>
      ))}
    </svg>
  );
}

const hrs = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : `${Math.round(h)} h`);

/**
 * The off-machine backup: not set up (and where the docs say how), or the last copy that was verified by
 * reading it back (when, where, which), with a red warning when it is over a day old or none ever was.
 */
export function OffsiteBackup({ status: o, docs }: { status: HealthView['offsiteBackup']; docs: string | null }) {
  const doc = docs ? (
    <a href={docs} target="_blank" rel="noreferrer" className="text-blue-ink hover:underline" data-testid="health-offsite-docs">
      docs/backups.md
    </a>
  ) : (
    <code className="font-mono text-[12px]">docs/backups.md</code>
  );
  return (
    <section className="overflow-hidden rounded-card bg-surface shadow-card" aria-label="Off-machine backup" data-testid="health-offsite">
      <div className="primitive-card-pad">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-ink">Off-machine backup</span>
          {!o ? <Badge>not set up</Badge> : o.stale ? <Badge tone="danger">stale</Badge> : <Badge tone="ok">verified {hrs(o.ageHours!)} ago</Badge>}
        </div>
        {!o ? (
          <div className="mt-1.5 text-[13px] leading-relaxed text-ink-2" data-testid="health-offsite-none">
            Nothing is copied off this machine: the event log's backups stay on its disk. To turn it on, put <code className="font-mono text-[12px]">offsite-backup.yaml</code> in the instance home; {doc} says what goes in it.
          </div>
        ) : (
          <>
            {o.stale && (
              <div role="alert" className="mt-2 rounded-control bg-red-tint px-3 py-2 text-[12.5px] text-ink-2" data-testid="health-offsite-stale">
                <span className="font-semibold text-red">{o.lastOkAt ? `The last verified copy is ${hrs(o.ageHours!)} old.` : 'No copy has been verified yet.'}</span>
                {o.lastError && (
                  <div className="mt-1">
                    The latest attempt, {ago(o.lastAttemptAt)}, failed: <code className="font-mono text-[12px] break-all" data-testid="health-offsite-error">{o.lastError.slice(0, 300)}</code>
                  </div>
                )}
                <div className="mt-1">Check the commands in the instance&apos;s offsite-backup.yaml ({doc}).</div>
              </div>
            )}
            <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-[12.5px]">
              <dt className="text-ink-3">Last verified copy</dt>
              <dd className="tabular-nums text-ink" data-testid="health-offsite-last" title={o.lastOkAt ?? undefined}>
                {o.lastOkAt ? `${ago(o.lastOkAt)} (${new Date(o.lastOkAt).toISOString().replace('T', ' ').slice(0, 16)} UTC)` : 'never'}
              </dd>
              <dt className="text-ink-3">Destination</dt>
              <dd className="text-ink" data-testid="health-offsite-destination">
                {o.destination}
              </dd>
              {o.lastOkKey && (
                <>
                  <dt className="text-ink-3">Copy</dt>
                  <dd className="truncate font-mono text-[12px] text-ink-2" data-testid="health-offsite-key">
                    {o.lastOkKey}
                  </dd>
                </>
              )}
              <dt className="text-ink-3">Last attempt</dt>
              <dd className="text-ink-2">{o.lastError ? `${ago(o.lastAttemptAt)}, failed` : ago(o.lastAttemptAt)}</dd>
            </dl>
          </>
        )}
      </div>
      <div className="primitive-card-footer border-t border-line text-[12px] text-ink-3">A copy counts only once it has been fetched back, decrypted and matched against the snapshot.</div>
    </section>
  );
}

export interface InstanceHealth {
  name: string;
  view: HealthView | null;
  error: string | null;
}

/**
 * The machine's outbound proxy and custom CA, read-only: set by root in network.json (docs/network.md), never from the
 * page. A refused file is said in red: children then go direct and trust only their own stores.
 */
export function OutboundProxy({ network: n }: { network: NonNullable<HealthView['network']> }) {
  if (n.error)
    return (
      <div role="alert" className="rounded-control bg-red-tint px-3 py-2 text-[12.5px] text-ink-2" data-testid="health-network-refused">
        <span className="font-medium text-red">Outbound proxy and custom CA refused:</span> <span className="break-all">{n.error}</span>
      </div>
    );
  return (
    <div className="space-y-0.5 text-[12.5px] text-ink-2">
      {n.proxy && (
        <div data-testid="health-network">
          Outbound proxy: <code className="font-mono text-[12px]">{n.proxy}</code> (from <code className="font-mono text-[12px]">{n.file}</code>)
        </div>
      )}
      {n.ca && (
        <div data-testid="health-network-ca">
          Custom CA: <code className="font-mono text-[12px] break-all">{n.ca.path}</code>, {n.ca.count} {n.ca.count === 1 ? 'certificate' : 'certificates'}, {n.ca.fingerprints.length === 1 ? 'fingerprint' : 'fingerprints'}{' '}
          <code className="font-mono text-[12px]">{n.ca.fingerprints.map((f) => `sha256:${f}`).join(', ')}</code> (from <code className="font-mono text-[12px]">{n.file}</code>)
        </div>
      )}
    </div>
  );
}

/**
 * Where provider runs may send their key and prompts, read-only: root's hosts in providers.json (docs/providers.md),
 * never set from the page. No file, no host or a refused file means provider runs are off; a refused file, and each
 * configured provider whose base_url is outside the set, in red.
 */
export function ProviderHosts({ hosts: p }: { hosts: NonNullable<HealthView['providerHosts']> }) {
  const file = <code className="font-mono text-[12px]">{p.file}</code>;
  return (
    <div className="space-y-0.5 text-[12.5px] text-ink-2">
      {p.state === 'refused' ? (
        <div role="alert" className="rounded-control bg-red-tint px-3 py-2" data-testid="health-provider-hosts-refused">
          <span className="font-medium text-red">Provider hosts refused:</span> <span className="break-all">{p.error}</span>. Provider runs are off.
        </div>
      ) : p.state === 'missing' ? (
        <div data-testid="health-provider-hosts-none">
          No provider hosts: {file} doesn&apos;t exist, so provider runs are off (root writes it: docs/providers.md)
        </div>
      ) : (
        <div data-testid="health-provider-hosts">
          Provider hosts: {p.hosts.length ? <code className="font-mono text-[12px]">{p.hosts.join(', ')}</code> : 'none, so provider runs are off'} (from {file})
        </div>
      )}
      {p.refused.length > 0 && (
        <ul data-testid="health-provider-refused">
          {p.refused.map((r) => (
            <li key={r.provider}>
              <span className="font-medium text-red">
                Provider <code className="font-mono text-[12px]">{r.provider}</code> refused:
              </span>{' '}
              <span className="break-all">{r.reason}</span>; its runs take the role&apos;s normal model
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Total: the budget files are written by anyone who can write the slot directory, so a number may arrive as null or
// NaN, and a time as anything; each shows as "–" rather than throwing (there is no error boundary to catch a throw).
const count = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '–');
const validTime = (iso: unknown): iso is string => typeof iso === 'string' && Number.isFinite(Date.parse(iso)) && Math.abs(Date.parse(iso)) <= 8.64e15;
const utc = (iso: unknown) => (validTime(iso) ? `${new Date(iso).toISOString().slice(11, 16)} UTC` : '–');
const inMin = (iso: string) => {
  const min = Math.round((Date.parse(iso) - Date.now()) / 60_000);
  return min < 1 ? 'in under a minute' : `in ${min} min`;
};

/**
 * The machine's shared GitHub API budget (src/github/budget.ts), read-only: per credential, what is left and when it
 * resets per resource, a back-off in force (in red), and the consumers that used most of the current window.
 * Credentials are numbered, never named by their token.
 */
export function GitHubBudget({ budget }: { budget: NonNullable<HealthView['githubRate']> }) {
  const cell = 'primitive-table-cell text-[12.5px] tabular-nums text-ink-2';
  return (
    <section className="space-y-1.5" aria-label="GitHub API budget" data-testid="health-github-budget">
      <div className="text-[13px] font-medium text-ink">GitHub API budget</div>
      {budget.error && (
        <div className="text-[12.5px] text-ink-2" data-testid="health-github-budget-error">
          GitHub API budget not shown: {budget.error}
        </div>
      )}
      {budget.credentials.length > 0 && (
        <RecordsTable testId="health-github-budget-table" head={['Credential', 'Left', 'Resets', 'Back-off', 'Top consumers']} className="[&_th:nth-child(1)]:w-28">
          {budget.credentials.map((c) => (
            <tr key={c.id} className="border-b border-line last:border-0 align-top" data-testid="health-github-budget-row">
              <td className="primitive-table-cell text-[13px] text-ink" title={validTime(c.updatedAt) ? `changed ${ago(c.updatedAt)}` : 'changed at a time not known'}>
                {c.id}
              </td>
              <td className={cell}>
                {c.resources.length
                  ? c.resources.map((r) => <div key={r.resource}>{r.remaining === null ? `${r.resource} not known yet` : `${r.resource} ${count(r.remaining)}${r.limit ? ` of ${count(r.limit)}` : ''} left`}</div>)
                  : 'not known yet'}
              </td>
              <td className={cell}>{c.resources.length ? c.resources.map((r) => <div key={r.resource}>{validTime(r.resetAt) ? `${r.resource} ${utc(r.resetAt)} (${inMin(r.resetAt)})` : `${r.resource} –`}</div>) : '–'}</td>
              <td className="primitive-table-cell text-[12.5px] text-ink-2" data-testid="health-github-budget-backoff">
                {c.backoff ? <span className="font-medium text-red">{`${c.backoff.kind === 'secondary_rate_limited' ? 'secondary limit' : 'rate limit'}: paused until ${utc(c.backoff.until)}`}</span> : 'none'}
              </td>
              <td className="primitive-table-cell text-[12.5px] text-ink-2">{c.top.length ? c.top.map((t) => `${t.consumer} ${count(t.calls)}`).join(' · ') : '–'}</td>
            </tr>
          ))}
        </RecordsTable>
      )}
      {budget.notShown > 0 && (
        <div className="text-[12px] text-ink-3" data-testid="health-github-budget-not-shown">
          {budget.notShown} more budget {budget.notShown === 1 ? 'file' : 'files'} not shown (past the newest readable few, or not readable as one)
        </div>
      )}
      <div className="text-[11.5px] text-ink-3">Shared by every process on this machine that calls GitHub with the same token; a back-off pauses all of them. Credentials are numbered here, never named by their token.</div>
    </section>
  );
}

/** The panel from its data (also what the render checks render). `instances`: on a hub, every instance's view. */
/** A held engine update, in red: rolled back (a failed migration, or services that didn't come up) and not retried. */
export function UpdateHold({ hold }: { hold: NonNullable<HealthView['updateHold']> }) {
  return (
    <div role="alert" className="rounded-control bg-red-tint px-3 py-2 text-[12.5px] text-ink-2" data-testid="health-update-held">
      <span className="font-medium text-red">{hold.migration ? 'Engine update rolled back: a migration failed' : 'Engine update rolled back'}</span>
      {' '}({new Date(hold.at).toISOString().slice(0, 16).replace('T', ' ')} UTC{hold.sha ? `, ${hold.sha.slice(0, 12)}` : ''}): {hold.reason}. Every instance runs the previous engine; this commit is held until a newer one, or until an admin releases it at a root shell: sudo bash scripts/setup/updates.sh --release-hold.
    </div>
  );
}

export function HealthPanelView({ view, instances }: { view: HealthView; instances?: InstanceHealth[] }) {
  const m = view.machine;
  const today = new Date().toISOString().slice(0, 10);
  const units = (m?.units ?? []).filter(isOk);
  const unitErrors = (m?.units ?? []).filter((u): u is Extract<Unit, { error: string }> => !isOk(u));
  const quiet = view.suggestions.length === 1 && NOTHING.test(view.suggestions[0]!);
  return (
    <section className="space-y-3" aria-label="Machine health" data-testid="health-panel">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Machine health</span>
        {m && <span className="text-[12px] text-ink-3">read {ago(m.at)}</span>}
      </div>

      <div className="overflow-hidden rounded-card bg-surface shadow-card" data-testid="health-suggestions">
        <div className="primitive-card-pad">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-ink">Suggestions</span>
            <Badge tone={quiet ? 'ok' : 'warn'}>{quiet ? 'nothing to do' : `${view.suggestions.length} to consider`}</Badge>
          </div>
          <ul className="mt-1.5 space-y-1 text-[13px] leading-relaxed text-ink-2">
            {view.suggestions.map((s, i) => (
              <li key={i} data-testid="health-suggestion">
                {s}
              </li>
            ))}
          </ul>
        </div>
        <div className="primitive-card-footer border-t border-line text-[12px] text-ink-3">Suggestions only: nothing is changed for you.</div>
      </div>

      {(() => {
        // The machine's, so any instance's view (on the hub) shows it.
        const hold = view.updateHold ?? instances?.map((i) => i.view?.updateHold).find(Boolean) ?? null;
        return hold ? <UpdateHold hold={hold} /> : null;
      })()}

      {(() => {
        // The machine's, so any instance's view (on the hub) shows it.
        const network = view.network ?? instances?.map((i) => i.view?.network).find(Boolean) ?? null;
        return network ? <OutboundProxy network={network} /> : null;
      })()}

      {/* This instance's: its configured providers are checked against the machine's hosts. */}
      {view.providerHosts && <ProviderHosts hosts={view.providerHosts} />}

      {(() => {
        // The machine's, so any instance's view (on the hub) shows it.
        const budget = view.githubRate ?? instances?.map((i) => i.view?.githubRate).find(Boolean) ?? null;
        return budget ? <GitHubBudget budget={budget} /> : null;
      })()}

      <OffsiteBackup status={view.offsiteBackup ?? null} docs={view.docs?.backups ?? null} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="health-machine">
        {m?.memory ? (
          <Figure testId="health-memory" label="Memory available" value={gb(m.memory.availableBytes)} hint={`of ${gb(m.memory.totalBytes)}`}>
            <Usage used={m.memory.totalBytes - m.memory.availableBytes} total={m.memory.totalBytes} warnAt={90} label="memory in use" />
          </Figure>
        ) : (
          <Figure testId="health-memory" label="Memory available" value="not measured" hint="read on Linux only" />
        )}
        {m?.memory ? (
          <Figure testId="health-swap" label="Swap in use" value={m.memory.swapTotalBytes ? gb(m.memory.swapTotalBytes - m.memory.swapFreeBytes) : 'no swap'} hint={m.memory.swapTotalBytes ? `of ${gb(m.memory.swapTotalBytes)}` : undefined}>
            {m.memory.swapTotalBytes > 0 && <Usage used={m.memory.swapTotalBytes - m.memory.swapFreeBytes} total={m.memory.swapTotalBytes} warnAt={25} label="swap in use" />}
          </Figure>
        ) : (
          <Figure testId="health-swap" label="Swap in use" value="not measured" />
        )}
        <Figure testId="health-load" label="Load (5 min)" value={m?.load ? m.load[1].toFixed(1) : 'not measured'} hint={m?.load ? `${view.cores ?? '?'} cores · 1 min ${m.load[0].toFixed(1)} · 15 min ${m.load[2].toFixed(1)}` : undefined} />
        {disksOnce(m?.disks ?? []).map((d) =>
          'error' in d ? (
            <Figure key={d.path} testId="health-disk" label={`Disk free: ${d.path}`} value="not read" hint={d.error} />
          ) : (
            <Figure key={d.path} testId="health-disk" label="Disk free" value={gb(d.freeBytes)} hint={`${Math.round((d.freeBytes / Math.max(d.totalBytes, 1)) * 100)}% of ${gb(d.totalBytes)} · ${d.path}`}>
              <Usage used={d.totalBytes - d.freeBytes} total={d.totalBytes} warnAt={90} label={`disk in use on ${d.path}`} />
            </Figure>
          ),
        )}
      </div>

      {(units.length > 0 || unitErrors.length > 0) && (
        <RecordsTable testId="health-units" head={['Service', 'State', 'Memory', 'Swap', 'CPU time']} className="[&_th:nth-child(2)]:w-24 [&_th:nth-child(4)]:w-24 [&_th:nth-child(5)]:w-24">
          {units.map((u) => (
            <tr key={u.unit} className="border-b border-line last:border-0" data-testid="health-unit-row">
              <td className="primitive-table-cell truncate font-mono text-[12px] text-ink" title={u.unit}>
                {u.unit}
              </td>
              <td className="primitive-table-cell">
                <DotPill tone={u.activeState === 'active' ? 'green' : u.activeState === 'failed' ? 'red' : 'ink'}>{u.activeState ?? '?'}</DotPill>
              </td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">
                {u.memoryCurrent === null ? 'not accounted' : u.memoryMax ? `${gb(u.memoryCurrent)} of ${gb(u.memoryMax)}` : `${gb(u.memoryCurrent)} (no limit)`}
                {u.memoryCurrent !== null && u.memoryMax ? <Usage used={u.memoryCurrent} total={u.memoryMax} warnAt={90} label={`${u.unit} memory against its limit`} /> : null}
              </td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{u.memorySwapCurrent === null ? '–' : gb(u.memorySwapCurrent)}</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{u.cpuUsageNSec === null ? '–' : cpu(u.cpuUsageNSec)}</td>
            </tr>
          ))}
          {unitErrors.map((u) => (
            <tr key={u.unit} className="border-b border-line last:border-0" data-testid="health-unit-row">
              <td className="primitive-table-cell truncate font-mono text-[12px] text-ink">{u.unit}</td>
              <td colSpan={4} className="primitive-table-cell text-[12px] text-ink-3">
                not read: {u.error}
              </td>
            </tr>
          ))}
        </RecordsTable>
      )}

      {instances && instances.length > 0 && (
        <RecordsTable testId="health-instances" head={['Instance', 'Service memory', 'Runs today', 'Est. cost today', 'Usage limit hits', 'Off-machine backup', 'Suggestions']} className="[&_th:nth-child(3)]:w-24 [&_th:nth-child(5)]:w-28">
          {instances.map((i) => {
            const t = i.view?.usage.days.find((d) => d.day === today);
            const svc = (i.view?.machine?.units ?? []).filter(isOk).find((u) => u.unit.endsWith('.service'));
            const n = i.view ? (i.view.suggestions.length === 1 && NOTHING.test(i.view.suggestions[0]!) ? 0 : i.view.suggestions.length) : null;
            return (
              <tr key={i.name} className="border-b border-line last:border-0" data-testid="health-instance-row">
                <td className="primitive-table-cell text-[13px] font-medium text-ink">{i.name}</td>
                {i.view ? (
                  <>
                    <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{svc?.memoryCurrent != null ? `${gb(svc.memoryCurrent)}${svc.memoryMax ? ` of ${gb(svc.memoryMax)}` : ''}` : '–'}</td>
                    <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{t?.runs ?? 0}</td>
                    <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2" title={EST_NOTE}>
                      {t?.estimatedUsd === undefined && t ? '–' : estUsd(t?.estimatedUsd ?? 0)}
                    </td>
                    <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{t?.rateLimited ?? 0}</td>
                    <td className="primitive-table-cell text-[12.5px]" data-testid="health-instance-offsite">
                      {!i.view.offsiteBackup ? <span className="text-ink-3">not set up</span> : i.view.offsiteBackup.stale ? <Badge tone="danger">{i.view.offsiteBackup.lastOkAt ? `stale, ${hrs(i.view.offsiteBackup.ageHours!)}` : 'never verified'}</Badge> : <span className="text-ink-2">{hrs(i.view.offsiteBackup.ageHours!)} ago</span>}
                    </td>
                    <td className="primitive-table-cell">{n ? <Badge tone="warn">{n} to consider</Badge> : <Badge tone="ok">none</Badge>}</td>
                  </>
                ) : (
                  <td colSpan={6} className="primitive-table-cell text-[12px] text-red">
                    not answering: {i.error}
                  </td>
                )}
              </tr>
            );
          })}
        </RecordsTable>
      )}

      {view.merge && (
        <section className="space-y-1.5" aria-label="Merge flow" data-testid="health-merge">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-[13px] font-medium text-ink">Merge flow</span>
            <span className="text-[12px] text-ink-3">
              since {new Date(view.merge.since).toLocaleDateString()} · {view.merge.mergedPrs} merged PR(s)
            </span>
          </div>
          <RecordsTable testId="health-merge-table" head={['What', 'How many', 'Minutes', 'Per merged PR', '']} className="[&_th:nth-child(2)]:w-24 [&_th:nth-child(3)]:w-28 [&_th:nth-child(4)]:w-32">
            <tr className="border-b border-line last:border-0" data-testid="health-merge-row" data-measure="conflicts">
              <td className="primitive-table-cell text-[13px] text-ink">Conflict fixes</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{view.merge.conflicts.count}</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{view.merge.conflicts.medianMinutes === null ? '–' : `${view.merge.conflicts.medianMinutes} median to merged`}</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{view.merge.conflicts.perMergedPr} min</td>
              <td className="primitive-table-cell text-[12px]" data-testid="health-merge-need-owner">
                {view.merge.conflicts.needOwner ? <Badge tone="warn">{view.merge.conflicts.needOwner} needed the owner</Badge> : <span className="text-ink-3">none needed the owner</span>}
              </td>
            </tr>
            <tr className="border-b border-line last:border-0" data-testid="health-merge-row" data-measure="light-checks">
              <td className="primitive-table-cell text-[13px] text-ink">Light checks</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{view.merge.lightChecks.count}</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{view.merge.lightChecks.minutesAdded} added</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{view.merge.lightChecks.perMergedPr} min</td>
              <td className="primitive-table-cell text-[12px] text-ink-3">{Object.entries(view.merge.lightChecks.outcomes).map(([k, n]) => `${k} ${n}`).join(' · ') || '–'}</td>
            </tr>
            <tr className="border-b border-line last:border-0" data-testid="health-merge-row" data-measure="holds">
              <td className="primitive-table-cell text-[13px] text-ink">Hotspot holds</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{view.merge.holds.count}</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{view.merge.holds.minutesWaited} waited</td>
              <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{view.merge.holds.perMergedPr} min</td>
              <td className="primitive-table-cell truncate font-mono text-[12px] text-ink-3" title={view.merge.holds.byFile.map((f) => `${f.file}: ${f.minutes} min (${f.count})`).join(', ')}>
                {view.merge.holds.byFile[0] ? `most on ${view.merge.holds.byFile[0].file}` : '–'}
              </td>
            </tr>
          </RecordsTable>
        </section>
      )}

      <section className="space-y-1.5" aria-label="Check times" data-testid="health-checks">
        <div className="text-[13px] font-medium text-ink">Check times</div>
        {view.checks.timings.length ? (
          <RecordsTable testId="health-checks-table" head={['Check', 'Last 5 (median)', 'Before (median)', 'Change', 'Recent runs']} className="[&_th:nth-child(2)]:w-32 [&_th:nth-child(3)]:w-32 [&_th:nth-child(4)]:w-28 [&_th:nth-child(5)]:w-36">
            {view.checks.timings.map((c) => {
              const change = c.priorMedianMs ? Math.round(((c.recentMedianMs - c.priorMedianMs) / c.priorMedianMs) * 100) : null;
              return (
                <tr key={c.check} className="border-b border-line last:border-0" data-testid="health-check-row" style={{ background: c.regression ? 'var(--orange-tint)' : undefined }}>
                  <td className="primitive-table-cell truncate font-mono text-[12px] text-ink" title={c.check}>
                    {c.check}
                    {view.checks.slowest.includes(c.check) && <span className="ml-2 font-sans text-[11.5px] text-ink-3">slowest</span>}
                  </td>
                  <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink">{dur(c.recentMedianMs)}</td>
                  <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{c.priorMedianMs === null ? 'not enough runs' : dur(c.priorMedianMs)}</td>
                  <td className="primitive-table-cell">
                    {c.regression ? (
                      <span data-testid="health-regression">
                        <Badge tone="warn">slower +{c.regression.slowerPct}%</Badge>
                      </span>
                    ) : change === null ? (
                      <span className="text-[12px] text-ink-3">–</span>
                    ) : (
                      <span className="text-[12.5px] tabular-nums text-ink-2">{change > 0 ? `+${change}%` : `${change}%`}</span>
                    )}
                  </td>
                  <td className="primitive-table-cell">
                    <Sparkline series={c.series} />
                  </td>
                </tr>
              );
            })}
          </RecordsTable>
        ) : (
          <Card className="p-4 text-[13px] text-ink-3">No timed check runs yet: times are recorded from the next checks the coordinator runs.</Card>
        )}
        <div className="text-[11.5px] text-ink-3">{view.checks.rule}</div>
      </section>

      <section className="space-y-1.5" aria-label="Usage per day" data-testid="health-usage">
        <div className="text-[13px] font-medium text-ink">Claude usage per day</div>
        {view.usage.days.length ? (
          <RecordsTable testId="health-usage-table" head={['Day (UTC)', 'Runs', 'Est. cost', 'Usage limit hits', 'Login trouble', 'Retries', 'Login waits']}>
            {view.usage.days.map((d) => {
              const retries = Object.entries(d.retries);
              return (
                <tr key={d.day} className="border-b border-line last:border-0" data-testid="health-usage-row">
                  <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink">{d.day}</td>
                  <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{d.runs}</td>
                  <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2" title={EST_NOTE}>
                    {d.estimatedUsd === undefined ? '–' : estUsd(d.estimatedUsd)}
                  </td>
                  <td className={cx('primitive-table-cell text-[12.5px] tabular-nums', d.rateLimited ? 'text-orange' : 'text-ink-2')}>{d.rateLimited}</td>
                  <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{d.authProblems}</td>
                  <td className="primitive-table-cell text-[12px] text-ink-2" title={retries.map(([k, n]) => `${k}: ${n}`).join(', ')}>
                    {retries.length ? `${retries.reduce((s, [, n]) => s + n, 0)} (${retries.map(([k, n]) => `${k} ${n}`).join(', ')})` : '0'}
                  </td>
                  <td className="primitive-table-cell text-[12.5px] tabular-nums text-ink-2">{d.lockWaits ? `${d.lockWaits}, ${dur(d.lockWaitMs)}` : '0'}</td>
                </tr>
              );
            })}
          </RecordsTable>
        ) : (
          <Card className="p-4 text-[13px] text-ink-3">No runs recorded yet.</Card>
        )}
        <div className="rounded-control bg-inset px-2.5 py-2 text-[12px] text-ink-2 shadow-hairline" data-testid="health-quota-note">
          {view.usage.quotaNote}
        </div>
      </section>

      {!!m?.unavailable.length && (
        <div className="text-[11.5px] text-ink-3" data-testid="health-unavailable">
          Not measured here: {m.unavailable.join('; ')}
        </div>
      )}
    </section>
  );
}

/** Loads /api/health (every 30 s while shown); on a hub with All instances chosen, also each instance's own view for the side-by-side table. */
export function HealthPanel({ onLoaded }: { onLoaded?: () => void }) {
  const [view, setView] = useState<HealthView | null>(null);
  const [instances, setInstances] = useState<InstanceHealth[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const v = await api<HealthView>('/api/health');
        if (!live) return;
        setView(v);
        setError(null);
        // Side by side only when All instances is chosen in the switcher; otherwise this instance's view alone.
        const [h, scope] = await Promise.all([hub, instanceScope]);
        if (h && scope.all && live) {
          const shown = h.instances.filter((i) => scope.instances.includes(i.name));
          const all = await Promise.all(shown.map(async (i) => (i.up ? onInstance<HealthView>(i.name, '/api/health').then((v2) => ({ name: i.name, view: v2, error: null }), (e: Error) => ({ name: i.name, view: null, error: e.message })) : { name: i.name, view: null, error: i.error ?? 'not answering' })));
          if (live) setInstances(all);
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
      // The first look is done, the side-by-side table with it (web/src/in-order.tsx).
      if (live) onLoaded?.();
    };
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (error) return <div className="text-[13px] text-red" data-testid="health-panel">Can't load machine health: {error}</div>;
  if (!view) return null;
  return <HealthPanelView view={view} {...(instances ? { instances } : {})} />;
}
