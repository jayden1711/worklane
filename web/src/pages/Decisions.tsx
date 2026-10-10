import { useEffect, useMemo, useState } from 'react';
import { decide, type Decision, type State } from '../api';
import { navigate, pageKey, typing } from '../App';
import { ago, Avatar, Badge, Button, Card, cx, Empty, Kbd } from '../components/ui';
import { Header } from './Overview';

export function DecisionCard({ d, selected, onAnswered }: { d: Decision; selected: boolean; onAnswered?: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const answer = async (a: string) => {
    setBusy(a);
    setErr(null);
    try {
      await decide(d.id, a);
      onAnswered?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card id={d.id} className={cx('p-4 transition-shadow', selected && 'ring-2 ring-ring')} data-decision={d.id}>
      <div className="flex items-start gap-3">
        <Avatar login={d.owner} size={24} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {d.issue !== null && (
              <button className="font-mono text-info hover:underline" onClick={() => navigate(`/issues/${d.issue}`)}>
                #{d.issue}
              </button>
            )}
            <Badge tone={d.kind === 'land' ? 'danger' : 'warn'}>{d.kind === 'land' ? 'Approve landing' : 'Question'}</Badge>
            <span>for @{d.owner}</span>
            <span>· asked {ago(d.askedAt)}</span>
          </div>
          <div className="mt-1.5 text-sm font-medium">{d.question}</div>
          <div className="mt-1 text-sm">
            <span className="text-muted-foreground">Recommendation: </span>
            {d.recommendation}
          </div>
          {!!d.receipts.filter(Boolean).length && (
            <ul className="mt-2 space-y-0.5 rounded-md bg-muted/60 p-2 text-xs text-muted-foreground">
              {d.receipts.filter(Boolean).map((r, i) => (
                <li key={i} className="truncate" title={r}>
                  {r}
                </li>
              ))}
            </ul>
          )}
          {!d.answer && d.canAnswer === false ? (
            <div className="mt-3 text-xs text-muted-foreground">Waiting on @{d.owner}; only they or one of the project's writers can answer it.</div>
          ) : d.answer ? (
            <div className="mt-3 text-xs text-muted-foreground">
              Answered <span className="font-medium text-foreground">{d.answer.answer}</span> by @{d.answer.by} {ago(d.answer.at)}
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {d.options.map((o, i) => (
                <Button key={o} size="sm" variant={o === d.recommendation || (i === 0 && !d.options.includes(d.recommendation)) ? 'default' : /reject|close/.test(o) ? 'danger' : 'outline'} disabled={!!busy} onClick={() => void answer(o)}>
                  {busy === o ? '…' : o} <Kbd>{i + 1}</Kbd>
                </Button>
              ))}
              {err && <span className="text-xs text-danger">{err}</span>}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

export function Decisions({ state }: { state: State }) {
  const [showAnswered, setShowAnswered] = useState(false);
  const open = useMemo(() => state.decisions.filter((d) => !d.answer), [state.decisions]);
  const list = showAnswered ? state.decisions : open;
  const [sel, setSel] = useState(0);

  useEffect(() => {
    const hash = window.location.hash.slice(1);
    const i = hash ? list.findIndex((d) => d.id === hash) : -1;
    if (i >= 0) setSel(i);
  }, [list]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!pageKey(e)) return;
      const cur = list[sel];
      if (e.key === 'j') setSel((s) => Math.min(list.length - 1, s + 1));
      else if (e.key === 'k') setSel((s) => Math.max(0, s - 1));
      else if (cur && (cur.answer || cur.canAnswer === false) && (/^[1-9]$/.test(e.key) || e.key === 'a' || e.key === 'r')) return;
      else if (cur && !cur.answer && /^[1-9]$/.test(e.key)) {
        const o = cur.options[Number(e.key) - 1];
        if (o) void decide(cur.id, o);
      } else if (cur && !cur.answer && (e.key === 'a' || e.key === 'r')) {
        const o = cur.options.find((x) => (e.key === 'a' ? /approve/.test(x) : /reject|close/.test(x)));
        if (o) void decide(cur.id, o);
      } else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [list, sel]);

  useEffect(() => {
    document.querySelector(`[data-decision="${list[sel]?.id}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel, list]);

  return (
    <div>
      <Header title="Decisions" sub={`${open.length} waiting`}>
        <span className="hidden items-center gap-1 text-xs text-muted-foreground md:flex">
          <Kbd>j</Kbd>/<Kbd>k</Kbd> move · <Kbd>1-9</Kbd> answer · <Kbd>a</Kbd> approve · <Kbd>r</Kbd> reject
        </span>
        <Button size="sm" variant="outline" onClick={() => setShowAnswered((v) => !v)}>
          {showAnswered ? 'Hide answered' : 'Show answered'}
        </Button>
      </Header>
      <div className="mx-auto max-w-3xl space-y-3 p-6">
        {list.length ? list.map((d, i) => <DecisionCard key={d.id} d={d} selected={i === sel} />) : <Empty title="Nothing to decide" hint="When a change needs your approval, or an agent asks a real question, it shows up here and in your Inbox." />}
      </div>
    </div>
  );
}
