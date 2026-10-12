// The machine this instance runs on: its agent slots (shared by every instance and harness on it), its health
// (memory, swap, load, disk, the harness's services, the off-machine backup, check times, usage, and on a hub the
// instances side by side), and the machine-wide settings (the slot cap, engine updates) with their history.
import type { State } from '../api';
import { HealthPanel } from '../components/HealthPanel';
import { MachineSettings } from '../components/MachineSettings';
import { RecordsTable } from '../components/patterns';
import { ago } from '../components/ui';
import { Header } from './Overview';

/** The machine's agent slots: how many of the cap are in use, and who holds each (also what the render checks render). */
export function MachineSlots({ slots }: { slots: State['slots'] }) {
  return (
    <section className="space-y-1.5" aria-label="Agent slots" data-testid="machine-slots">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Agent slots</span>
        <span className="text-[12px] tabular-nums text-ink-3">
          {slots.running} of {slots.cap} in use, machine-wide{slots.fullRun ? ` · full test run: ${slots.fullRun.owner}` : ''}
        </span>
      </div>
      {slots.agents.length ? (
        <RecordsTable head={['Slot', 'Held by', 'Since']} className="[&_th:nth-child(1)]:w-28 [&_th:nth-child(3)]:w-32">
          {slots.agents.map((a) => (
            <tr key={a.slot} className="border-b border-line last:border-0" data-testid="machine-slot-row">
              <td className="primitive-table-cell font-mono text-[12px] text-ink">{a.slot}</td>
              <td className="primitive-table-cell truncate text-[12.5px] text-ink-2" title={a.owner}>
                {a.owner}
              </td>
              <td className="primitive-table-cell text-[12.5px] text-ink-3">{ago(a.acquiredAt)}</td>
            </tr>
          ))}
        </RecordsTable>
      ) : (
        <div className="rounded-card bg-surface px-3 py-2.5 text-[12.5px] text-ink-3 shadow-card">No agent is running on this machine.</div>
      )}
    </section>
  );
}

export function MachinePage({ state }: { state: State }) {
  return (
    <div data-testid="page-machine">
      <Header title="Machine" sub="the always-on machine: slots, health and machine-wide settings, shared by every instance on it" />
      <div className="space-y-6 p-6">
        <MachineSlots slots={state.slots} />
        <HealthPanel />
        <MachineSettings />
      </div>
    </div>
  );
}
