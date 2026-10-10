import { useEffect, useMemo, useRef, useState } from 'react';
import { Columns3, List, Save, X } from 'lucide-react';
import { listViews, saveViews, type Filters, type SavedView, type State, type Task, type TaskStatus } from '../api';
import { navigate, pageKey, typing } from '../App';
import { ago, Avatar, Badge, Button, Card, cx, Empty, Kbd, LevelBadge, STATUS_LABEL, StatusBadge, EST_NOTE, estUsd } from '../components/ui';
import { Header } from './Overview';

const TABS: { key: string; label: string; statuses: TaskStatus[] }[] = [
  { key: 'current', label: 'Current', statuses: ['claimed', 'reproducing', 'building', 'verifying', 'evaluating', 'awaiting_decision', 'queued', 'blocked'] },
  { key: 'planning', label: 'Planning', statuses: ['ready'] },
  { key: 'backlog', label: 'Backlog', statuses: ['triage', 'released'] },
  { key: 'done', label: 'Done', statuses: ['landed', 'done'] },
];

const BOARD_COLUMNS: { label: string; statuses: TaskStatus[] }[] = [
  { label: 'Ready', statuses: ['ready'] },
  { label: 'In progress', statuses: ['claimed', 'reproducing', 'building'] },
  { label: 'Verifying', statuses: ['verifying', 'evaluating'] },
  { label: 'Needs decision', statuses: ['awaiting_decision'] },
  { label: 'Landing', statuses: ['queued'] },
  { label: 'Blocked', statuses: ['blocked'] },
  { label: 'Done', statuses: ['landed', 'done'] },
];

export function areaOf(t: Task, state: State): string {
  for (const a of state.owners.areas) if (a.labels.some((l) => t.labels.includes(l))) return a.name;
  return 'other';
}

function builtinViews(state: State): SavedView[] {
  const others = state.owners.writers.filter((w) => w.toLowerCase() !== state.user.toLowerCase());
  return [
    { name: 'Mine', filters: { owner: state.user } },
    { name: 'Collaborator', filters: { owner: others[0] ?? '' } },
    { name: 'Money-path', filters: { label: 'money-path' } },
    { name: 'Blocked', filters: { status: 'blocked' } },
  ];
}

function matches(t: Task, f: Filters): boolean {
  if (f.owner && (t.owner ?? '').toLowerCase() !== f.owner.toLowerCase()) return false;
  if (f.status && t.status !== f.status) return false;
  if (f.level && t.level !== f.level) return false;
  if (f.label && !t.labels.includes(f.label)) return false;
  if (f.text) {
    const q = f.text.toLowerCase();
    if (!`#${t.issue} ${t.title} ${t.labels.join(' ')}`.toLowerCase().includes(q)) return false;
  }
  return true;
}

function Row({ t, selected }: { t: Task; selected: boolean }) {
  return (
    <button data-issue={t.issue} onClick={() => navigate(`/issues/${t.issue}`)} className={cx('flex w-full items-center gap-3 px-4 py-2 text-left text-sm hover:bg-accent', selected && 'bg-accent')}>
      <span className="w-12 shrink-0 font-mono text-xs text-muted-foreground">#{t.issue}</span>
      <StatusBadge status={t.status} />
      <span className="min-w-0 flex-1 truncate">{t.title}</span>
      <span className="hidden gap-1 xl:flex">
        {t.labels.filter((l) => !['ready', 'agent:working', 'in-review'].includes(l) && !l.startsWith('review:')).slice(0, 3).map((l) => (
          <Badge key={l}>{l}</Badge>
        ))}
      </span>
      <LevelBadge level={t.level} />
      <span className="flex items-center -space-x-1">
        <Avatar login={t.owner} title={`owner @${t.owner ?? 'unassigned'}`} />
        {t.delegate && <Avatar login={`${t.delegate.role}@${t.delegate.instance}`} title={`agent delegate: ${t.delegate.role} (${t.delegate.instance})`} />}
      </span>
      <span className="hidden w-14 text-right text-xs tabular-nums text-muted-foreground sm:block" title={t.costUsd ? EST_NOTE : undefined}>{t.costUsd ? estUsd(t.costUsd) : ''}</span>
      <span className="w-14 text-right text-xs text-muted-foreground">{ago(t.lastActivity)}</span>
    </button>
  );
}

function BoardCard({ t }: { t: Task }) {
  return (
    <button onClick={() => navigate(`/issues/${t.issue}`)} className="w-full rounded-card bg-surface p-2.5 text-left text-[13px] shadow-card transition-shadow hover:shadow-raised">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">#{t.issue}</span>
        <LevelBadge level={t.level} />
        <span className="ml-auto flex -space-x-1">
          <Avatar login={t.owner} size={18} />
          {t.delegate && <Avatar login={`${t.delegate.role}@${t.delegate.instance}`} size={18} />}
        </span>
      </div>
      <div className="mt-1 line-clamp-2">{t.title}</div>
      {t.status === 'blocked' && t.blockedReason && <div className="mt-1 line-clamp-2 text-xs text-danger">{t.blockedReason}</div>}
    </button>
  );
}

export function Issues({ state }: { state: State }) {
  const params = new URLSearchParams(window.location.search);
  const builtins = useMemo(() => builtinViews(state), [state]);
  const [tab, setTab] = useState(params.get('tab') ?? 'current');
  const [mode, setMode] = useState<'list' | 'board'>(() => {
    try {
      return (localStorage.getItem('dash-issues-mode') as 'list' | 'board') ?? 'list';
    } catch {
      return 'list';
    }
  });
  const [lanes, setLanes] = useState(false);
  const [filters, setFilters] = useState<Filters>(() => builtins.find((v) => v.name === params.get('view'))?.filters ?? {});
  const [custom, setCustom] = useState<SavedView[]>([]);
  const [sel, setSel] = useState(0);
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listViews().then(setCustom).catch(() => setCustom([]));
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem('dash-issues-mode', mode);
    } catch {
      // preference only
    }
  }, [mode]);

  const tabDef = TABS.find((t) => t.key === tab) ?? TABS[0]!;
  const anyFilter = Object.values(filters).some(Boolean);
  // A status or owner filter searches every tab; otherwise the tab scopes the list.
  const rows = state.tasks.filter((t) => (filters.status || mode === 'board' ? true : tabDef.statuses.includes(t.status)) && matches(t, filters));

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === '/' && !typing(e)) {
        e.preventDefault();
        search.current?.focus();
        return;
      }
      if (e.key === 'Escape' && typing(e)) {
        (e.target as HTMLElement).blur();
        return;
      }
      if (!pageKey(e)) return;
      if (e.key === 'j') setSel((s) => Math.min(rows.length - 1, s + 1));
      else if (e.key === 'k') setSel((s) => Math.max(0, s - 1));
      else if (e.key === 'Enter' && rows[sel]) navigate(`/issues/${rows[sel]!.issue}`);
      else if (e.key === 'b') setMode((m) => (m === 'list' ? 'board' : 'list'));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [rows, sel]);

  useEffect(() => {
    document.querySelector(`[data-issue="${rows[sel]?.issue}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel, rows]);

  const owners = [...new Set(state.tasks.map((t) => t.owner).filter(Boolean) as string[])];
  const labels = [...new Set(state.tasks.flatMap((t) => t.labels))].filter((l) => !l.startsWith('review:') && !['ready', 'agent:working', 'in-review'].includes(l));
  const saveCurrent = async () => {
    const name = window.prompt('Name this view');
    if (!name) return;
    const next = [...custom.filter((v) => v.name !== name), { name, filters }];
    setCustom(next);
    await saveViews(next);
  };

  const Chip = ({ k, value, label }: { k: keyof Filters; value: string; label?: string }) => (
    <button onClick={() => setFilters((f) => ({ ...f, [k]: f[k] === value ? undefined : value }))} className={cx('rounded-full border px-2.5 py-0.5 text-xs', filters[k] === value ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent')}>
      {label ?? value}
    </button>
  );

  const areas = lanes ? [...new Set(rows.map((t) => areaOf(t, state)))] : ['all'];

  return (
    <div>
      <Header title="Issues" sub={`${rows.length} shown`}>
        <span className="hidden items-center gap-1 text-xs text-muted-foreground lg:flex">
          <Kbd>/</Kbd> search · <Kbd>j</Kbd>/<Kbd>k</Kbd> · <Kbd>↵</Kbd> open · <Kbd>b</Kbd> board
        </span>
        <div className="flex rounded-full bg-hover-2 p-0.5">
          <button onClick={() => setMode('list')} className={cx('rounded px-2 py-1', mode === 'list' && 'bg-accent')} aria-label="List view" title="List">
            <List className="size-4" />
          </button>
          <button onClick={() => setMode('board')} className={cx('rounded px-2 py-1', mode === 'board' && 'bg-accent')} aria-label="Board view" title="Board">
            <Columns3 className="size-4" />
          </button>
        </div>
      </Header>
      <div className="space-y-3 border-b px-6 py-3">
        <div className="flex flex-wrap items-center gap-1">
          {mode === 'list' &&
            TABS.map((t) => (
              <button key={t.key} onClick={() => setTab(t.key)} className={cx('rounded-full px-2.5 py-1 text-[12.5px]', tab === t.key ? 'bg-surface font-medium text-ink shadow-btn' : 'text-ink-2 hover:text-ink')}>
                {t.label} <span className="text-xs text-muted-foreground">{state.tasks.filter((x) => t.statuses.includes(x.status)).length}</span>
              </button>
            ))}
          <span className="mx-2 h-4 w-px bg-border" />
          {[...builtins, ...custom].map((v) => (
            <button key={v.name} onClick={() => setFilters(v.filters)} className={cx('rounded-full px-2.5 py-1 text-[12px]', JSON.stringify(v.filters) === JSON.stringify(filters) ? 'bg-ink text-surface' : 'text-ink-2 hover:bg-hover-2')}>
              {v.name}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <input type="checkbox" checked={lanes} onChange={(e) => setLanes(e.target.checked)} /> Swimlanes by area
            </label>
            {anyFilter && (
              <>
                <Button size="sm" variant="ghost" onClick={() => void saveCurrent()}>
                  <Save className="size-3.5" /> Save view
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setFilters({})}>
                  <X className="size-3.5" /> Clear
                </Button>
              </>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            ref={search}
            value={filters.text ?? ''}
            onChange={(e) => setFilters((f) => ({ ...f, text: e.target.value || undefined }))}
            placeholder="Filter…"
            className="h-7 w-44 rounded-control bg-field px-2 text-[12.5px] text-ink shadow-hairline outline-none placeholder:text-ink-3 focus:shadow-[0_0_0_1px_var(--blue)]"
          />
          {owners.map((o) => (
            <Chip key={o} k="owner" value={o} label={`@${o}`} />
          ))}
          {['L0', 'L1', 'L2', 'L3'].map((l) => (
            <Chip key={l} k="level" value={l} />
          ))}
          {labels.slice(0, 12).map((l) => (
            <Chip key={l} k="label" value={l} />
          ))}
        </div>
      </div>
      <div className="p-6">
        {!rows.length ? (
          <Empty title="No issues match" hint={anyFilter ? 'Clear the filters or pick another view.' : 'Issues appear once the coordinator has seen them on the backlog.'} />
        ) : mode === 'list' ? (
          <div className="space-y-4">
            {areas.map((area) => {
              const items = rows.filter((t) => area === 'all' || areaOf(t, state) === area);
              return (
                <div key={area}>
                  {lanes && <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{area}</div>}
                  <Card className="divide-y overflow-hidden">
                    {items.map((t) => (
                      <Row key={t.issue} t={t} selected={rows.indexOf(t) === sel} />
                    ))}
                  </Card>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-6">
            {areas.map((area) => (
              <div key={area}>
                {lanes && <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{area}</div>}
                <div className="flex gap-3 overflow-x-auto pb-2">
                  {BOARD_COLUMNS.map((col) => {
                    const items = rows.filter((t) => col.statuses.includes(t.status) && (area === 'all' || areaOf(t, state) === area));
                    return (
                      <div key={col.label} className="w-64 shrink-0">
                        <div className="mb-2 flex items-center justify-between px-1 text-xs font-medium text-muted-foreground">
                          <span>{col.label}</span>
                          <span>{items.length}</span>
                        </div>
                        <div className="space-y-2 rounded-card bg-canvas p-2" title={col.statuses.map((s) => STATUS_LABEL[s]).join(', ')}>
                          {items.map((t) => (
                            <BoardCard key={t.issue} t={t} />
                          ))}
                          {!items.length && <div className="py-4 text-center text-xs text-muted-foreground">empty</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
