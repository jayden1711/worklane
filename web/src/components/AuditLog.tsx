import { api, useFetch } from '../api';
import { ago, Badge, Card, Empty } from './ui';

/** One write made on the dashboard (GET /api/audit): who, with which role, how they came in, and what they did. */
export interface AuditEntry {
  id: number;
  at: string;
  login: string;
  role: 'owner' | 'writer' | 'viewer';
  via: 'session' | 'break-glass' | 'discord' | 'siri';
  instance: string | null;
  action: string;
  detail: Record<string, unknown>;
}

const detailText = (d: Record<string, unknown>) =>
  Object.entries(d)
    .map(([k, v]) => `${k} ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');

/** The audit log as rendered: newest first. */
export function AuditLogView({ entries }: { entries: AuditEntry[] }) {
  return (
    <Card className="overflow-hidden" data-testid="audit-log">
      <div className="border-b border-line px-4 py-2 text-[13px] font-medium text-ink">Audit log</div>
      {entries.length ? (
        <ul className="divide-y divide-line">
          {entries.map((e) => (
            <li key={e.id} className="flex items-center gap-3 px-4 py-2 text-[13px]" data-testid="audit-row">
              <span className="w-16 shrink-0 text-xs text-ink-3" title={e.at}>
                {ago(e.at)}
              </span>
              <span className="w-44 shrink-0 truncate font-medium text-ink-2">
                @{e.login} <span className="font-normal text-ink-3">{e.via === 'break-glass' ? 'break-glass' : e.via === 'siri' ? 'Siri' : e.role}</span>
              </span>
              <Badge>{e.action}</Badge>
              <span className="min-w-0 flex-1 truncate text-ink-3">{detailText(e.detail)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="p-4">
          <Empty title="No writes recorded yet" />
        </div>
      )}
    </Card>
  );
}

/** The owners' audit log: every write on this instance's dashboard. */
export function AuditLog({ pulse = 0 }: { pulse?: number }) {
  const { data, error } = useFetch(() => api<{ entries: AuditEntry[] }>('/api/audit'), pulse);
  if (error) return <div className="text-[12.5px] text-red">Can't load the audit log: {error}</div>;
  return data ? <AuditLogView entries={data.entries} /> : null;
}
