// Settings, Siri devices (docs/siri.md): the list (owners and writers; writers read-only), a new token (owners only,
// from an allowed console device or the break-glass, shown once), revoke (owners, from anywhere: a lost phone is cut
// off from any browser) and unbind (owners, from an allowed device: it lets the token bind to another phone).
// Every change, and every refusal of one, is audited by the dashboard as the person who made it.
import type { Role } from '../dashboard-auth.js';
import { loadIntakeConfig } from '../intake/config.js';
import { createDevice, DEVICE_ID, listDevices, revokeDevice, SiriTokenError, unbindDevice } from './tokens.js';

export const SIRI_DEVICES_PATH = '/api/siri-devices';

export interface SiriManager {
  login: string;
  role: Role;
  via: 'session' | 'break-glass';
  deviceOk: boolean;
}

export interface SiriManageOptions {
  stateDir: string;
  instance: string | null;
  intakeFile?: string;
  audit: (action: string, detail: Record<string, unknown>) => void;
  now?: () => Date;
}

type Answer = { status: number; body: unknown };

function enabled(intakeFile: string | undefined): boolean {
  const c = intakeFile ? loadIntakeConfig(intakeFile) : null;
  return !!c && !('error' in c) && c.config.siri.enabled;
}

/** Why this person may not make a token (or unbind one) here, or null. */
export function createRefusal(who: SiriManager, instance: string | null): string | null {
  if (!instance) return 'Siri devices are made on a server instance, behind the hub';
  if (who.role !== 'owner') return `only the instance's owners make Siri tokens; @${who.login} is a ${who.role}`;
  if (who.via !== 'break-glass' && !who.deviceOk) return "a Siri token is a credential: make it from one of the console's allowed Tailscale devices (dashboards.sh --console-devices), or on the machine";
  return null;
}

/** GET and POST on /api/siri-devices[/<id>/(revoke|unbind)]; null when the path isn't one of these. */
export function siriDevicesRoute(who: SiriManager, method: string, path: string, body: Record<string, unknown>, o: SiriManageOptions): Answer | null {
  if (path !== SIRI_DEVICES_PATH && !path.startsWith(`${SIRI_DEVICES_PATH}/`)) return null;
  if (who.role !== 'owner' && who.role !== 'writer') return { status: 403, body: { error: `the Siri devices are the instance's owners' and writers'; @${who.login} is a ${who.role}` } };
  const now = o.now?.() ?? new Date();
  if (path === SIRI_DEVICES_PATH && method === 'GET') {
    return { status: 200, body: { enabled: enabled(o.intakeFile), server: !!o.instance, owner: who.role === 'owner', createRefused: createRefusal(who, o.instance), devices: listDevices(o.stateDir, now.getTime()) } };
  }
  if (method !== 'POST') return { status: 405, body: { error: 'GET the list, or POST to change it' } };
  if (who.role !== 'owner') {
    o.audit('siri.refused_change', { path, why: 'not an owner' });
    return { status: 403, body: { error: `only the instance's owners change Siri devices; @${who.login} is a writer` } };
  }
  if (path === SIRI_DEVICES_PATH) {
    const no = createRefusal(who, o.instance);
    if (no) {
      o.audit('siri.refused_change', { action: 'create', why: no });
      return { status: 403, body: { error: no } };
    }
    try {
      const { token, device } = createDevice({ stateDir: o.stateDir, instance: o.instance!, name: String(body.name ?? ''), by: who.login, now });
      o.audit('siri.token_created', { device: device.name, token: device.id });
      // The only time the token leaves the server. Never logged, stored in clear or shown again.
      return { status: 200, body: { token, device } };
    } catch (e) {
      if (e instanceof SiriTokenError) return { status: 400, body: { error: e.message } };
      throw e;
    }
  }
  const m = path.slice(SIRI_DEVICES_PATH.length + 1).match(/^([a-z2-7]+)\/(revoke|unbind)$/);
  if (!m || !DEVICE_ID.test(m[1]!)) return { status: 404, body: { error: 'not found' } };
  const [, id, what] = m as unknown as [string, string, 'revoke' | 'unbind'];
  if (what === 'unbind') {
    const no = createRefusal(who, o.instance);
    if (no) {
      o.audit('siri.refused_change', { action: 'unbind', token: id, why: no });
      return { status: 403, body: { error: no } };
    }
  }
  try {
    const device = what === 'revoke' ? revokeDevice(o.stateDir, id, who.login, now) : unbindDevice(o.stateDir, id);
    o.audit(what === 'revoke' ? 'siri.token_revoked' : 'siri.unbound', { device: device.name, token: id });
    return { status: 200, body: { device } };
  } catch (e) {
    if (e instanceof SiriTokenError) return { status: 404, body: { error: e.message } };
    throw e;
  }
}
