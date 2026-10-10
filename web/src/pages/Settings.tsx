import type { ReactNode } from 'react';
import { getSettings, useFetch } from '../api';
import { InstanceSettings } from '../components/InstanceSettings';
import { MachineSettings } from '../components/MachineSettings';
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

const list = (xs: string[] | undefined) => (xs?.length ? xs.join(', ') : <span className="text-muted-foreground">none</span>);

export function SettingsPage() {
  const { data: s, error } = useFetch(getSettings);
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
      <div className="px-6 pt-6">
        <MachineSettings />
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

        <Section title="Agents">
          <Row k="Daily budget">${s.agents.budget}</Row>
          <Row k="Roles">
            <ul className="space-y-1">
              {s.agents.roles.map((r) => (
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

        <Section title="Machine and tests">
          <Row k="Max load">{s.governor.max_load ?? '2 × cores'}</Row>
          <Row k="Min free disk">{s.governor.min_free_disk_pct}%</Row>
          {Object.entries(s.tests.gates).map(([k, v]) => (
            <Row key={k} k={`Gate: ${k}`}>
              {list(v)}
            </Row>
          ))}
          <Row k="Batch size">up to {s.tests.batchMax}</Row>
          <Row k="Nightly">{s.tests.nightlyAt ?? <span className="text-muted-foreground">off</span>}</Row>
          <Row k="Baseline parser">{s.tests.baselineParser ? 'configured' : <span className="text-danger">missing: a red main can't land anything</span>}</Row>
        </Section>

        <Section title="Review and guardrails">
          {s.review &&
            Object.entries(s.review.levels).map(([k, v]) => (
              <Row key={k} k={k.replace('_', ' ')}>
                {list(v)}
              </Row>
            ))}
          <Row k="Guardrail rules">{s.guardrails.rules}</Row>
          <Row k="Protected paths">{list(s.guardrails.protectedPaths)}</Row>
          <Row k="Network">{s.guardrails.network}</Row>
          <Row k="Pre-approved tools">{list(s.guardrails.preApproved)}</Row>
          <Row k="Environments">
            {s.deploy ? list(s.deploy.environments.map((e) => `${e.name}${e.production ? ' (production)' : ''}`)) : <span className="text-muted-foreground">none</span>}
          </Row>
          <Row k="Production reads">{s.deploy?.prodRead ? 'one sanctioned read-only path' : 'none'}</Row>
        </Section>
      </div>
    </div>
  );
}
