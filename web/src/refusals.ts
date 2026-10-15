// What a viewer is refused, from what the state says, before anything is asked: the shell needs these without the
// pages' code (each page is its own chunk: App.tsx).
import type { State } from './api';

/** For a viewer the state says may not read the service log, the refusal the server would give; null for the owner and writers. */
export const logsRefusal = (state: Pick<State, 'canReadLogs' | 'user' | 'role'>) =>
  state.canReadLogs === false ? `the service log is for the instance's owners and writers (admin or write on its repo); @${state.user || 'unknown'} is a ${state.role ?? 'viewer'}` : null;

/** For a viewer the state says may not read agent runs, the refusal the server would give; null for the owner and writers. */
export const runsRefusal = (state: Pick<State, 'canReadRuns' | 'owners' | 'user' | 'role'>) =>
  state.canReadRuns === false ? `agent runs are for the instance's owners and writers (admin or write on its repo); @${state.user || 'unknown'} is a ${state.role ?? 'viewer'}` : null;
