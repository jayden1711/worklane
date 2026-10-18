// Needs you (#585): one queue of everything that waits for you, from the Inbox, Waiting on you and Decisions (the tabs
// beside it), each thing once, in the order needs-you.ts computes and this page states. Each row opens its own page.
// What waits on the owner is read by the shell (it counts the sidebar's badge from the same answer) and handed here.
import type { State, Waiting } from '../api';
import { navigate } from '../App';
import { Badge, Card, Empty } from '../components/ui';
import { Header } from '../components/Header';
import { KIND, needsYou, ORDER, type NeedItem } from '../needs-you';
import { waited, waitingRefusal } from './Waiting';

function Row({ i, now }: { i: NeedItem; now?: number }) {
  const subject = [i.pr !== null ? `PR #${i.pr}` : null, i.issue !== null ? `${i.pr !== null ? 'for ' : ''}#${i.issue}` : null].filter(Boolean).join(' ');
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5" data-testid="needs-you-item" data-kind={i.kind} data-blocking={i.blocking ? 'yes' : 'no'}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <Badge tone={i.blocking ? 'warn' : 'neutral'}>{KIND[i.kind].label}</Badge>
          {subject && <span className="font-mono text-[12.5px] text-ink-2">{subject}</span>}
          {i.title && <span className="min-w-0 break-words text-[13px] text-ink">{i.title}</span>}
        </div>
        <div className="mt-0.5 break-words text-[12.5px] text-ink-2">{i.detail}</div>
      </div>
      <span className="text-[12px] tabular-nums text-ink-3" title={i.since}>
        {KIND[i.kind].holds ? `holds ${KIND[i.kind].holds}; ` : ''}waiting {waited(i.since, now)}
      </span>
      {i.href && (
        <a href={i.href} onClick={(e) => (e.preventDefault(), navigate(i.href!))} className="inline-flex items-center justify-center text-[12px] font-medium text-blue-ink hover:underline" data-testid="needs-you-open">
          Open
        </a>
      )}
    </li>
  );
}

/** The queue from the state and what /api/waiting answered (null data: not answered yet, or refused). */
export function NeedsYouPage({ state, waiting, now }: { state: State; waiting: { data: Waiting | null; error: string | null }; now?: number }) {
  const refused = waitingRefusal(state);
  const pending = !refused && !waiting.data && !waiting.error;
  const items = needsYou(state, waiting.data);
  const landed = state.inbox.notify.length;
  return (
    <div data-testid="page-needs-you">
      <Header title="Needs you" sub={pending ? 'everything that waits until you act' : `${items.length} waiting on you; nothing here times out`} />
      <div className="mx-auto max-w-4xl space-y-4 p-6 max-md:p-4">
        <p className="text-[12.5px] text-ink-2" data-testid="needs-you-order">
          {ORDER}
        </p>
        {refused && <p className="text-[12.5px] text-ink-3">{refused.replace(/^what/, 'What')}: this queue has the decisions and your blocked tasks.</p>}
        {waiting.error && !refused && <p className="text-[12.5px] text-red">Can't load what waits: {waiting.error}. Shown: the decisions and your blocked tasks.</p>}
        {pending ? (
          <div className="text-[13px] text-ink-3" role="status">
            Reading what waits on you…
          </div>
        ) : items.length ? (
          <Card className="overflow-hidden">
            <ul className="divide-y divide-line">
              {items.map((i) => (
                <Row key={i.key} i={i} {...(now !== undefined ? { now } : {})} />
              ))}
            </ul>
          </Card>
        ) : (
          <Empty title="Nothing needs you" hint="Decisions, held plans and PRs, blocks and stops show up here until you act on them." />
        )}
        {!!landed && (
          <p className="text-[12.5px] text-ink-3">
            Not in the queue: {landed} L2 {landed === 1 ? 'change' : 'changes'} landed for you to look over, on the{' '}
            <a href="/needs-you/inbox" onClick={(e) => (e.preventDefault(), navigate('/needs-you/inbox'))} className="text-blue-ink hover:underline">
              Inbox
            </a>
            .
          </p>
        )}
      </div>
    </div>
  );
}
