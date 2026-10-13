// The pre-deploy gate (docs/deploy-gate.md): the commit the deploy branch is at (the host deploys production from it),
// the last default-branch commit the gate held back and why, and a refusal in force (the branch moved outside the gate).
// Configured but off (deploy_gate.enabled not true): says so, and what turning it on would do.
import type { DeployGate } from '../api';
import { ago, Badge } from './ui';

export function DeployGateStatus({ gate }: { gate: DeployGate | undefined }) {
  if (!gate) return null;
  if (!gate.enabled) return <DeployGateOff gate={gate} />;
  const tone = gate.refused ? 'danger' : gate.held ? 'warn' : 'ok';
  const label = gate.refused ? 'Refused' : gate.held ? 'Held' : 'Moving';
  const sha = (x: { sha: string; url: string }) => (
    <a className="font-mono text-ink underline-offset-2 hover:underline" href={x.url} target="_blank" rel="noreferrer">
      {x.sha.slice(0, 8)}
    </a>
  );
  return (
    <section className="space-y-1.5" aria-label="Pre-deploy gate" data-testid="deploy-gate">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Pre-deploy gate</span>
        <Badge tone={tone}>{label}</Badge>
      </div>
      <div className="space-y-1 rounded-card bg-surface px-3 py-2.5 text-[12.5px] text-ink-2 shadow-card">
        <div data-testid="deploy-gate-deployed">
          Deployed (<span className="font-mono">{gate.branch}</span>):{' '}
          {gate.deployed ? (
            <>
              {sha(gate.deployed)}
              {gate.deployed.at ? `, ${ago(gate.deployed.at)}` : ''}
              {gate.deployed.override ? ` (owner override by @${gate.deployed.by ?? '?'})` : ''}
            </>
          ) : (
            'not moved by the gate yet'
          )}
        </div>
        {gate.held && (
          <div data-testid="deploy-gate-held">
            Held: {sha(gate.held)}, {ago(gate.held.at)}: {gate.held.reason}
          </div>
        )}
        {gate.refused && <div data-testid="deploy-gate-refused">Refused: {gate.refused.reason}</div>}
      </div>
    </section>
  );
}

/** Configured, off: nothing runs or moves; what `enabled: true` would do. */
function DeployGateOff({ gate }: { gate: DeployGate }) {
  return (
    <section className="space-y-1.5" aria-label="Pre-deploy gate" data-testid="deploy-gate">
      <div className="flex items-baseline gap-2">
        <span className="text-[13px] font-medium text-ink">Pre-deploy gate</span>
        <Badge tone="neutral">Configured, off</Badge>
      </div>
      <div className="space-y-1 rounded-card bg-surface px-3 py-2.5 text-[12.5px] text-ink-2 shadow-card" data-testid="deploy-gate-off">
        <div>
          Configured, off: nothing runs for the gate, <span className="font-mono">{gate.branch}</span> never moves, and a chat <span className="font-mono">deploy</span> is refused.
        </div>
        <div>
          Turning it on (<span className="font-mono">deploy_gate.enabled: true</span>, the owner's step, in a reviewed PR) would run {gate.tiers.join(', ')} on each new default-branch commit and fast-forward{' '}
          <span className="font-mono">{gate.branch}</span> to each one green on all of them
          {gate.postDeploy ? ', then smoke-test production after each deploy and roll it back on a failed check' : ''}.
        </div>
      </div>
    </section>
  );
}
