// The machine this instance runs on: its agent slots (shared by every instance and harness on it), how its default
// branch is guarded (GitHub, or the main watch), its health
// (memory, swap, load, disk, the harness's services, the off-machine backup, check times, usage, and on a hub the
// instances side by side), the test runs (queue, slots, the full-run lock's holder, tiers), and the machine-wide
// settings (the slot caps, engine updates) with their history, and above them the Updates panel (the engine installed,
// the last update, any rollback or hold, the canary's last result), and for the machine's owners the agents' Claude
// account and Tailscale and HTTPS for the hub.
import { DeployGateStatus } from '../components/DeployGate';
import type { State } from '../api';
import { HealthPanel } from '../components/HealthPanel';
import { ProtectionStatus } from '../components/Protection';
import { MachineSettings } from '../components/MachineSettings';
import { ClaudeAccountPanel } from '../components/ClaudeAccount';
import { TailscaleSetupPanel } from '../components/TailscaleSetup';
import { UpdatesPanel } from '../components/UpdatesPanel';
import { TestRunsPanel } from '../components/TestRuns';
import { RecordsTable } from '../components/patterns';
import { ago } from '../components/ui';
import { Header } from '../components/Header';
import { useEffect } from 'react';
import { InOrder, type PanelLoaded } from '../in-order';

/** For a viewer: the machine-wide settings aren't theirs (nothing to load, so it has its answer at once). */
function SettingsRefused({ onLoaded }: { onLoaded: PanelLoaded }) {
  useEffect(onLoaded, [onLoaded]);
  return (
    <div className="text-[12.5px] text-ink-3" data-testid="machine-settings-refused">
      The machine-wide settings and their history are for the owners and writers.
    </div>
  );
}

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
      {/* A viewer is sent the counts only, not which agents hold the slots. */}
      {!slots.agents ? (
        <div className="rounded-card bg-surface px-3 py-2.5 text-[12.5px] text-ink-3 shadow-card" data-testid="machine-slots-viewer">
          Which agents hold them is for the owners and writers.
        </div>
      ) : slots.agents.length ? (
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
      {/* A flex column with a gap, not space-y: a panel still waiting (display: none) or with nothing to show takes no gap. */}
      <div className="flex flex-col gap-6 p-6">
        <MachineSlots slots={state.slots} />
        <ProtectionStatus protection={state.protection} brand={state.brand.name} />
        <DeployGateStatus gate={state.deployGate} />
        {/* Each panel below loads its own data, and is shown in page order (web/src/in-order.tsx): a panel shows once
            every panel above it has answered, so none that answers late moves a button already on screen (the Updates
            panel answering after the machine settings moved Install down 208 px, onto the "Machine settings" heading). */}
        <InOrder
          testId="machine-panels"
          panels={[
            (loaded) => <TestRunsPanel onLoaded={loaded} />,
            (loaded) => <HealthPanel onLoaded={loaded} />,
            // The agents' Claude account: the machine owners' only; anyone else sees whether one is set, nothing more.
            (loaded) => <ClaudeAccountPanel onLoaded={loaded} accountSet={state.claudeAccount?.set} />,
            // Tailscale and HTTPS for the hub (the first-run wizard's screen): the machine owners' only, on a server instance.
            (loaded) => <TailscaleSetupPanel onLoaded={loaded} />,
            // The machine settings are the owners' and writers' (a viewer's request for them is refused).
            ...(state.canReadMachine
              ? [(loaded: PanelLoaded) => <UpdatesPanel onLoaded={loaded} />, (loaded: PanelLoaded) => <MachineSettings onLoaded={loaded} />]
              : [(loaded: PanelLoaded) => <SettingsRefused onLoaded={loaded} />]),
          ]}
        />
      </div>
    </div>
  );
}
