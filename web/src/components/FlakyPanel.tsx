// Flaky tests (GET /api/flaky, src/flaky.ts): a check that failed on the default branch and passed when re-run on the
// same commit is quarantined. It still runs and reports, but no longer stops auto-merge or opens a revert. Each row:
// the check, when first and last seen flaky, how often, its issue, and its passes in a row toward release. The flake
// rate: of the red runs on the default branch that were re-run, how many found a flaky test. Owners and writers read
// it; only an owner clears a test (it blocks again at once).
import { useEffect, useState } from 'react';
import { api, clearFlaky, type Flaky, type FlakyTest, type State } from '../api';
import { ago, Badge, Button, Card } from './ui';

const pct = (r: number | null) => (r === null ? '–' : `${Math.round(r * 1000) / 10}%`);

function Row({ t, releaseAfter, canClear, onCleared }: { t: FlakyTest; releaseAfter: number; canClear: boolean; onCleared: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clear = async () => {
    setBusy(true);
    setError(null);
    try {
      await clearFlaky(t.test);
      onCleared();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <tr className="border-t border-line align-top" data-testid="flaky-row" data-test={t.test}>
      <td className="px-3 py-2 font-mono text-[12.5px] text-ink">{t.test}</td>
      <td className="px-3 py-2 text-ink-2">{ago(t.firstSeen)}</td>
      <td className="px-3 py-2 tabular-nums text-ink-2" data-testid="flaky-sightings">
        {t.sightings}
      </td>
      <td className="px-3 py-2 text-ink-2">
        {t.url ? (
          <a className="underline-offset-2 hover:underline" href={t.url} target="_blank" rel="noreferrer">
            #{t.issue}
          </a>
        ) : (
          'not filed yet'
        )}
      </td>
      <td className="px-3 py-2 tabular-nums text-ink-2">
        {t.state === 'quarantined' ? `${t.passes} of ${releaseAfter}` : t.released ? `released ${ago(t.released.at)} (${t.released.how === 'owner' ? `by @${t.released.by}` : 'passes'})` : ''}
      </td>
      <td className="px-3 py-2">
        {t.state === 'quarantined' && canClear && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void clear()}>
            Clear
          </Button>
        )}
        {error && <div className="text-[12px] text-red">{error}</div>}
      </td>
    </tr>
  );
}

export function FlakyView({ f, onCleared = () => undefined }: { f: Flaky; onCleared?: () => void }) {
  const w7 = f.rates.find((r) => r.days === 7);
  const w30 = f.rates.find((r) => r.days === 30);
  const rows = [...f.quarantined, ...f.released];
  return (
    <section className="space-y-2" aria-label="Flaky tests" data-testid="flaky-panel">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Flaky tests</span>
        <Badge tone={f.quarantined.length ? 'warn' : 'ok'}>
          <span data-testid="flaky-count">{f.quarantined.length}</span> quarantined
        </Badge>
        <span className="text-[12.5px] text-ink-3" data-testid="flaky-rate">
          Flake rate: {pct(w7?.rate ?? null)} over 7 days ({w7?.flakyReruns ?? 0} of {w7?.redRuns ?? 0} red runs), {pct(w30?.rate ?? null)} over 30 days ({w30?.flakyReruns ?? 0} of {w30?.redRuns ?? 0})
        </span>
      </div>
      <p className="text-[12px] text-ink-3">
        A check that fails on the default branch is re-run on the same commit first. Passing then, it is quarantined: it still runs and reports, but no longer stops auto-merge or opens a revert. It blocks again after {f.releaseAfter} passes in a row, or when an owner clears it. The updater still needs every check green.
      </p>
      {rows.length ? (
        <Card className="overflow-x-auto">
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-ink-3">
              <tr>
                <th className="px-3 py-2 font-medium">Check</th>
                <th className="px-3 py-2 font-medium">First seen</th>
                <th className="px-3 py-2 font-medium">Sightings</th>
                <th className="px-3 py-2 font-medium">Issue</th>
                <th className="px-3 py-2 font-medium">Passes in a row</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((t) => (
                <Row key={`${t.state}-${t.test}`} t={t} releaseAfter={f.releaseAfter} canClear={f.canClear} onCleared={onCleared} />
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <div className="text-[12.5px] text-ink-3">No flaky tests found yet.</div>
      )}
    </section>
  );
}

export function FlakyPanel({ state }: { state: State }) {
  const [f, setF] = useState<Flaky | { error: string } | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (state.canWrite === false) return;
    api<Flaky>('/api/flaky')
      .then(setF)
      .catch((e: Error) => setF({ error: e.message }));
  }, [state.lastId, state.canWrite, n]);
  if (state.canWrite === false || !f) return null;
  if ('error' in f) return <div className="text-[13px] text-red">Can't load the flaky tests: {f.error}</div>;
  return <FlakyView f={f} onCleared={() => setN((x) => x + 1)} />;
}
