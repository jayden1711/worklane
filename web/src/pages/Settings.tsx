import type { ReactNode } from 'react';
import { getSettings, useFetch, type Settings } from '../api';
import { InstanceSettings } from '../components/InstanceSettings';
import { navigate } from '../App';
import { Loading } from '../components/patterns';
import { Badge, Card } from '../components/ui';
import { Header } from './Overview';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">{title}</div>
      <dl className="divide-y text-sm">{children}</dl>
    </Card>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="flex gap-4 px-4 py-2">
      <dt className="w-44 shrink-0 text-muted-foreground">{k}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

type Route = Settings['routing'][number];
const show = (v: Route['value']) => (Array.isArray(v) ? `[${v.join(', ')}]` : String(v));
const ALIAS = /^(model_routing|eval_routing)\./;

// WHY: read-only by design (item 32): routing changes go through a reviewed agents.yaml commit, never this page.
function RoutingSection({ routes, configDir }: { routes: Route[]; configDir: string }) {
  const inRepo = (r: Route) => !!r.from && /^(routing|model_routing|eval_routing)\./.test(r.from);
  // WHY: a bare `routing:` loads as null, which agents.yaml refuses; comment it out too when nothing is set.
  const snippet = [`${routes.some(inRepo) ? '' : '# '}routing:`, ...routes.map((r) => `${inRepo(r) ? '' : '# '}  ${r.key}: ${show(r.value)}`)].join('\n');
  return (
    <Card className="overflow-hidden lg:col-span-2" data-testid="settings-routing">
      <div className="primitive-card-bar border-b border-line text-[13px] font-medium text-ink">Model routing</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[12px] text-muted-foreground">
              <th className="px-4 py-2 font-normal">Task</th>
              <th className="px-4 py-2 font-normal">Uses</th>
              <th className="px-4 py-2 font-normal">From</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {routes.map((r) => (
              <tr key={r.key} data-testid="routing-row" data-key={r.key}>
                <td className="px-4 py-2 align-top">
                  <div className="font-mono text-[12.5px] text-ink">{r.key}</div>
                  <div className="text-[12px] text-muted-foreground">{r.task}</div>
                </td>
                <td className="px-4 py-2 align-top font-mono text-[12.5px]">{show(r.value)}</td>
                <td className="px-4 py-2 align-top">
                  {r.from === null ? (
                    <Badge>default</Badge>
                  ) : (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={ALIAS.test(r.from) ? 'warn' : 'info'}>{r.from.startsWith('policy.yaml') ? 'instance' : 'agents.yaml'}</Badge>
                      <span className="font-mono text-[12px] text-ink-2">{r.from}</span>
                      {ALIAS.test(r.from) && <span className="text-[12px] text-muted-foreground">old name: move to routing.{r.key}</span>}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="border-t border-line px-4 py-3 text-[12.5px]">
        <summary className="cursor-pointer text-ink-2">Change it</summary>
        <p className="mt-2 text-ink-3">
          Edit <span className="font-mono">{configDir}/agents.yaml</span> in a pull request; this page doesn't write it. Commented lines are defaults or role models.
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-inset p-3 font-mono text-[12px] text-ink" data-testid="routing-snippet">
          {snippet}
        </pre>
      </details>
    </Card>
  );
}

const list = (xs: string[] | undefined) => (xs?.length ? xs.join(', ') : <span className="text-muted-foreground">none</span>);

export function SettingsPage() {
  const { data: s, error } = useFetch(getSettings);
  // A viewer gets the project part only; the rest is the owners' and writers'.
  const full = s && !('forViewer' in s) ? s : null;
  if (error || !s)
    return (
      <div>
        <Header title="Settings" sub="read-only" />
        {error ? <div className="p-8 text-[13px] text-red">Can't load settings: {error}</div> : <Loading />}
      </div>
    );
  return (
    <div data-testid="page-settings">
      <Header title="Settings" sub={`the instance's settings, then the repo's config (read-only: change it in ${s.configDir}/ through a reviewed commit)`} />
      <div className="px-6 pt-6">
        <InstanceSettings />
      </div>
      <div className="px-6 pt-6 text-[12.5px] text-ink-2">
        The machine-wide settings (the agent slot cap, engine updates) and their history are on the{' '}
        {/* A link in the sentence (it stays inline on a phone, where every other control is a 44 px target). */}
        <a href="/machine" className="text-blue-ink hover:underline" onClick={(e) => (e.preventDefault(), navigate('/machine'))} data-testid="settings-machine-link">
          Machine page
        </a>
        . Each setup step (Connect GitHub, the tools, the hooks, ...) is checked again, and can be run again, on the{' '}
        <a href="/first-run" className="text-blue-ink hover:underline" onClick={(e) => (e.preventDefault(), navigate('/first-run'))} data-testid="settings-first-run-link">
          First run page
        </a>
        .
      </div>
      <div className="grid gap-6 p-6 lg:grid-cols-2">
        <Section title="Project">
          <Row k="Name">{s.project.name}</Row>
          <Row k="Repository">{s.project.repo}</Row>
          <Row k="Land mode">{s.project.landMode}</Row>
          <Row k="Default owner">@{s.owners.default}</Row>
          <Row k="Writers">{list(s.owners.writers.map((w) => `@${w}`))}</Row>
          <Row k="Areas">
            <ul className="space-y-0.5">
              {s.owners.areas.map((a) => (
                <li key={a.name}>
                  {a.name} <span className="text-muted-foreground">→ @{a.owner}</span>
                </li>
              ))}
            </ul>
          </Row>
          <Row k="Reports">
            {s.reports.times.join(' and ')} to {list(s.reports.to.map((u) => `@${u}`))}
          </Row>
        </Section>

        {full ? (
          <>
            <Section title="Agents">
              <Row k="Daily budget">${full.agents.budget}</Row>
              <Row k="Roles">
                <ul className="space-y-1">
                  {full.agents.roles.map((r) => (
                    <li key={r.name} className="flex items-center gap-2">
                      <Badge tone={r.enabled ? 'ok' : 'neutral'}>{r.enabled ? 'on' : 'off'}</Badge>
                      <span>{r.name}</span>
                      <span className="text-xs text-muted-foreground">
                        {r.model}
                        {r.count !== null ? ` · ${r.count}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </Row>
            </Section>

            <RoutingSection routes={full.routing} configDir={s.configDir} />

            <Section title="Machine and tests">
              <Row k="Max load">{full.governor.max_load ?? '2 × cores'}</Row>
              <Row k="Min free disk">{full.governor.min_free_disk_pct}%</Row>
              {Object.entries(full.tests.gates).map(([k, v]) => (
                <Row key={k} k={`Gate: ${k}`}>
                  {list(v)}
                </Row>
              ))}
              <Row k="Batch size">up to {full.tests.batchMax}</Row>
              <Row k="Nightly">{full.tests.nightlyAt ?? <span className="text-muted-foreground">off</span>}</Row>
              <Row k="Baseline parser">{full.tests.baselineParser ? 'configured' : <span className="text-danger">missing: a red main can't land anything</span>}</Row>
            </Section>

            <Section title="Review and guardrails">
              {full.review &&
                Object.entries(full.review.levels).map(([k, v]) => (
                  <Row key={k} k={k.replace('_', ' ')}>
                    {list(v)}
                  </Row>
                ))}
              <Row k="Guardrail rules">{full.guardrails.rules}</Row>
              <Row k="Protected paths">{list(full.guardrails.protectedPaths)}</Row>
              <Row k="Network">{full.guardrails.network}</Row>
              <Row k="Pre-approved tools">{list(full.guardrails.preApproved)}</Row>
              <Row k="Environments">
                {full.deploy ? list(full.deploy.environments.map((e) => `${e.name}${e.production ? ' (production)' : ''}`)) : <span className="text-muted-foreground">none</span>}
              </Row>
              <Row k="Production reads">{full.deploy?.prodRead ? 'one sanctioned read-only path' : 'none'}</Row>
            </Section>
          </>
        ) : (
          <Section title="The rest">
            <div className="px-4 py-3 text-[13px] text-ink-3" data-testid="settings-viewer-only">
              Agents, budgets, tests, review levels, guardrails and deploys are for the instance's owners and writers (write on its repo).
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
