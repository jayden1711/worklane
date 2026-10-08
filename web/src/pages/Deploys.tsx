import type { State } from '../api';
import { navigate } from '../App';
import { ago, Badge, Card, Empty } from '../components/ui';
import { Header } from './Overview';

const TONE = { verified: 'ok', failed: 'danger', requested: 'info' } as const;

export function Deploys({ state }: { state: State }) {
  const envs = [...new Set(state.deploys.map((d) => d.env))];
  const latest = envs.map((env) => state.deploys.find((d) => d.env === env)!);
  const waiting = state.tasks.filter((t) => t.landed && !t.deployed);
  const issueFor = (sha: string) => state.tasks.find((t) => t.landed === sha);
  return (
    <div>
      <Header title="Deploys" sub="what each environment is serving, as verified" />
      <div className="space-y-6 p-6">
        {latest.length ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {latest.map((d) => (
              <Card key={d.env} className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{d.env}</span>
                  <Badge tone={TONE[d.status as keyof typeof TONE] ?? 'neutral'}>{d.status}</Badge>
                </div>
                <div className="mt-2 font-mono text-xs">{d.sha.slice(0, 12)}</div>
                <div className="text-xs text-muted-foreground">{ago(d.at)}</div>
                {d.why && <div className="mt-1 truncate text-xs text-danger" title={d.why}>{d.why}</div>}
              </Card>
            ))}
          </div>
        ) : (
          <Empty title="No deploys recorded" hint="After landing, the coordinator checks each environment is serving the landed commit." />
        )}

        <Card>
          <div className="border-b px-4 py-2.5 text-sm font-medium">Landed, not yet verified anywhere ({waiting.length})</div>
          {waiting.length ? (
            <ul className="divide-y">
              {waiting.map((t) => (
                <li key={t.issue} className="flex items-center gap-3 px-4 py-2 text-sm">
                  <button className="font-mono text-xs text-info hover:underline" onClick={() => navigate(`/issues/${t.issue}`)}>
                    #{t.issue}
                  </button>
                  <span className="min-w-0 flex-1 truncate">{t.title}</span>
                  <span className="font-mono text-xs text-muted-foreground">{t.landed!.slice(0, 8)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4 text-xs text-muted-foreground">Everything landed is verified.</div>
          )}
        </Card>

        <Card>
          <div className="border-b px-4 py-2.5 text-sm font-medium">History</div>
          {state.deploys.length ? (
            <ul className="divide-y">
              {state.deploys.map((d, i) => {
                const t = issueFor(d.sha);
                return (
                  <li key={i} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="w-24">{d.env}</span>
                    <Badge tone={TONE[d.status as keyof typeof TONE] ?? 'neutral'}>{d.status}</Badge>
                    <span className="font-mono text-xs">{d.sha.slice(0, 8)}</span>
                    {t && (
                      <button className="min-w-0 truncate text-left text-xs text-info hover:underline" onClick={() => navigate(`/issues/${t.issue}`)}>
                        #{t.issue} {t.title}
                      </button>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">{ago(d.at)}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="p-4 text-xs text-muted-foreground">None yet.</div>
          )}
        </Card>
      </div>
    </div>
  );
}
