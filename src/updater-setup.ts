// The engine updater's setup, for the Machine page's "Updater setup" (the first-run wizard's Updates step, server
// mode): whether the updater is installed, the channel it follows, the release signers it verifies tags against, and
// the signers staged for an admin to confirm.
//
// Read-only here. Each change is one machine helper command (src/machine.ts), reviewed and confirmed by an owner,
// recorded as a machine request and run by the coordinator (src/machine-requests.ts): install-updater,
// set-update-channel release, stage-update-signer, discard-update-signer.
//
// The signers file is the root of trust for release updates, and nothing a dashboard session can do adds to it. The
// page can only STAGE a signer: the principal and key go into the helper's pending list, trusted for nothing. The
// page then shows the exact command an admin runs at a root shell on the machine to confirm it, naming the key by its
// fingerprint (scripts/setup/updates.sh --confirm-signer). A staged signer is dropped after 24 hours. Following main
// instead of releases is also a root shell's (updates.sh --channel main): the page offers no such choice.
import { readFileSync } from 'node:fs';
import { BRAND } from './brand.js';
import { MACHINE_HELPER, signerFingerprint, signerKeyOk, signerPrincipalOk, type UpdateChannelName } from './machine.js';
import { ENGINE_CURRENT, UPDATES_CONFIG, updateChannel } from './updates.js';

/** The signers file the updater reads (what a new updates.json names): written only by updates.sh, at a root shell. */
export const ALLOWED_SIGNERS = `/etc/${BRAND.cli}/allowed_signers`;
/** The helper's pending list (scripts/machine/, the helper's source; a test keeps the path, the limit and the 24 hours equal). */
export const PENDING_SIGNERS = `/var/lib/${BRAND.cli}/pending-signers.json`;
export const PENDING_MAX = 4;
export const PENDING_TTL_MS = 24 * 60 * 60_000;
const UPDATES_SCRIPT = 'scripts/setup/updates.sh';
/** The installed engine's copy: what an admin runs on the machine, wherever their shell is. */
const INSTALLED_SCRIPT = `${ENGINE_CURRENT}/${UPDATES_SCRIPT}`;

export interface ListedSigner {
  principal: string;
  /** Anything between the principal and the key (namespaces="git", valid-before=...), as written. */
  options: string;
  keyType: string;
  key: string;
  /** ssh-keygen's SHA256 fingerprint; null for a key that isn't base64. */
  fingerprint: string | null;
}

const KEY_TYPE = /^(ssh-|ecdsa-|sk-)[A-Za-z0-9@.-]+$/;

/** The signers a file lists, in its order (comments and blank lines left out); null when there is no file. */
export function listedSigners(path = ALLOWED_SIGNERS): ListedSigner[] | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  const out: ListedSigner[] = [];
  for (const raw of text.split('\n')) {
    const w = raw.trim().split(/\s+/);
    if (!w[0] || w[0].startsWith('#')) continue;
    const t = w.findIndex((x, i) => i > 0 && KEY_TYPE.test(x));
    if (t < 0 || !w[t + 1]) continue;
    const key = w[t + 1]!;
    out.push({ principal: w[0], options: w.slice(1, t).join(' '), keyType: w[t]!, key, fingerprint: /^[A-Za-z0-9+/]+=*$/.test(key) ? signerFingerprint(key) : null });
  }
  return out;
}

/** The command an admin runs, as root on the machine, to make the staged signer with this fingerprint a signer. */
export const confirmCommand = (fingerprint: string) => `sudo bash ${INSTALLED_SCRIPT} --confirm-signer ${fingerprint}`;

export interface PendingSigner {
  principal: string;
  key: string;
  fingerprint: string;
  /** The coordinator user that staged it (the helper's SUDO_USER), and so the instance whose dashboard asked. */
  by: string;
  instance: string | null;
  at: string;
  expiresAt: string;
  /** What confirms it: the only way it becomes a signer. */
  confirm: string;
}

/** The signers staged and still waiting (well-formed, under 24 hours old), as the helper itself reads its list. */
export function pendingSigners(path = PENDING_SIGNERS, now = Date.now()): PendingSigner[] {
  let list: unknown[] = [];
  try {
    const j = JSON.parse(readFileSync(path, 'utf8')) as { pending?: unknown };
    if (j && Array.isArray(j.pending)) list = j.pending;
  } catch {
    // none staged
  }
  const out: PendingSigner[] = [];
  for (const x of list) {
    const e = x as { principal?: unknown; key?: unknown; by?: unknown; instance?: unknown; at?: unknown } | null;
    if (!e || !signerPrincipalOk(e.principal) || !signerKeyOk(e.key) || typeof e.at !== 'string') continue;
    const age = now - Date.parse(e.at);
    if (!(age >= 0 && age < PENDING_TTL_MS)) continue;
    const fingerprint = signerFingerprint(e.key);
    out.push({ principal: e.principal, key: e.key, fingerprint, by: typeof e.by === 'string' ? e.by.slice(0, 64) : 'unknown', instance: typeof e.instance === 'string' && /^[a-z][a-z0-9-]{0,20}$/.test(e.instance) ? e.instance : null, at: e.at, expiresAt: new Date(Date.parse(e.at) + PENDING_TTL_MS).toISOString(), confirm: confirmCommand(fingerprint) });
  }
  return out.slice(0, PENDING_MAX);
}

export interface SignerToStage {
  principal: string;
  key: string;
  fingerprint: string;
  /** The line the confirming command will add, exactly. */
  line: string;
  /** The root command that confirms it. */
  confirm: string;
}

/**
 * The signer an owner typed: a principal, and a public key as `ssh-ed25519 AAAA... [comment]` (a .pub file's line) or
 * the key alone. The comment is dropped; nothing else is changed. Or why it can't be staged from the page.
 */
export function signerInput(principal: unknown, key: unknown): SignerToStage | { error: string } {
  const p = typeof principal === 'string' ? principal.trim() : '';
  if (!signerPrincipalOk(p)) return { error: 'the principal is one name of an email\'s shape (release@example.com): no spaces, wildcards, lists or options' };
  const w = (typeof key === 'string' ? key : '').trim().split(/\s+/).filter(Boolean);
  if (w[0] && KEY_TYPE.test(w[0]) && w[0] !== 'ssh-ed25519') return { error: `the page stages ssh-ed25519 keys only, not ${w[0]}: add another kind of key to ${ALLOWED_SIGNERS} at a root shell` };
  const k = w[0] === 'ssh-ed25519' ? w[1] : w.length === 1 ? w[0] : undefined;
  if (!signerKeyOk(k)) return { error: 'the public key is one ssh-ed25519 key: the line of a .pub file (ssh-ed25519 AAAAC3... comment), or its AAAAC3... part alone' };
  const fingerprint = signerFingerprint(k);
  return { principal: p, key: k, fingerprint, line: `${p} ssh-ed25519 ${k}`, confirm: confirmCommand(fingerprint) };
}

export const CHANNEL_WHAT: Record<UpdateChannelName, string> = {
  release: `the newest release tag vX.Y.Z, only when its signature verifies against a key listed in the signers file and its checks are green`,
  main: `main's newest commit whose checks are all green. There is no release tag on this channel, so no tag signature is checked: what main's required checks pass is what gets installed`,
};

export interface UpdaterSetup {
  installed: boolean;
  enabled: boolean | null;
  channel: UpdateChannelName | null;
  /** What the channel it is on follows. */
  channelWhat: string | null;
  /** The file the updater's signers are listed in. */
  signersFile: string;
  /** The file this machine's updates.json tells the updater to read, when it isn't that one (an admin's own setup). */
  updaterReads: string | null;
  /** null: no signers file yet. */
  signers: ListedSigner[] | null;
  /** Staged from a dashboard, waiting for an admin's confirming command; each is trusted for nothing until then. */
  pending: PendingSigner[];
  pendingMax: number;
  /** The same steps without the page: as root, from the engine's checkout. */
  script: { install: string; signer: string; confirm: string; release: string; main: string; releaseHold: string };
}

/** The updater's setup as the page shows it. */
export function updaterSetup(o: { updatesConfigPath?: string; signersPath?: string; pendingPath?: string; now?: number } = {}): UpdaterSetup {
  let cfg: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(readFileSync(o.updatesConfigPath ?? UPDATES_CONFIG, 'utf8')) as unknown;
    if (j && typeof j === 'object' && !Array.isArray(j)) cfg = j as Record<string, unknown>;
  } catch {
    // not installed
  }
  const signersFile = o.signersPath ?? ALLOWED_SIGNERS;
  const reads = cfg && typeof cfg.allowed_signers === 'string' ? cfg.allowed_signers : null;
  const channel = cfg ? updateChannel(cfg) : null;
  return {
    installed: !!cfg,
    enabled: cfg ? cfg.enabled === true : null,
    channel,
    channelWhat: channel ? CHANNEL_WHAT[channel] : null,
    signersFile,
    updaterReads: reads && reads !== ALLOWED_SIGNERS ? reads : null,
    signers: listedSigners(signersFile),
    pending: pendingSigners(o.pendingPath ?? PENDING_SIGNERS, o.now),
    pendingMax: PENDING_MAX,
    script: {
      install: `sudo bash ${UPDATES_SCRIPT}`,
      signer: `sudo bash ${UPDATES_SCRIPT} --signer <principal> ssh-ed25519 <public key>`,
      confirm: `sudo bash ${UPDATES_SCRIPT} --confirm-signer <SHA256 fingerprint of a staged signer>`,
      release: `sudo bash ${UPDATES_SCRIPT} --channel release`,
      main: `sudo bash ${UPDATES_SCRIPT} --channel main`,
      releaseHold: `sudo bash ${UPDATES_SCRIPT} --release-hold`,
    },
  };
}

export type UpdaterStep = 'install' | 'release' | 'stage' | 'discard';

export interface UpdaterPlan {
  step: UpdaterStep;
  /** The helper's arguments, exactly as the coordinator will run them. */
  args: string[];
  /** The whole command, for the page. */
  command: string;
  /** What it changes, and what it leaves alone. */
  changes: string[];
  /** The same without the page. */
  script: string;
  /** For a signer to stage: exactly what is staged, and the root command that would then confirm it. */
  signer?: SignerToStage & { file: string };
}

/** What one step of the setup would run and change, from what an owner entered; or why it can't. Changes nothing. */
export function updaterPlan(body: { step?: unknown; principal?: unknown; key?: unknown }, now: UpdaterSetup): UpdaterPlan | { error: string; status?: 400 | 409 } {
  const plan = (step: UpdaterStep, args: string[], changes: string[], script: string): UpdaterPlan => ({ step, args, command: `${MACHINE_HELPER} ${args.join(' ')}`, changes, script });
  if (body.step === 'install') {
    return plan(
      'install',
      ['install-updater'],
      [
        `installs /usr/local/libexec/${BRAND.cli}-update (root-owned) and ${BRAND.cli}-update.timer (every 10 minutes), from the installed engine's ${UPDATES_SCRIPT}`,
        now.installed ? `keeps ${UPDATES_CONFIG} as it is: its channel, its required checks, and whether updates are on` : `writes ${UPDATES_CONFIG} with updates off and the channel "release": nothing is installed until updates are turned on`,
        `doesn't touch ${ALLOWED_SIGNERS}`,
      ],
      now.script.install,
    );
  }
  if (body.step === 'release') {
    if (!now.installed) return { error: "the updater isn't installed on this machine yet: install it first" };
    if (now.channel === 'release') return { error: 'the updater already follows releases', status: 409 };
    return plan(
      'release',
      ['set-update-channel', 'release'],
      [`sets the channel in ${UPDATES_CONFIG} from "${now.channel}" to "release": the updater then follows ${CHANNEL_WHAT.release}`, `changes nothing else in ${UPDATES_CONFIG}: the required checks, the signers file it names, and whether updates are on stay as they are`, `doesn't touch ${ALLOWED_SIGNERS}`],
      now.script.release,
    );
  }
  if (body.step === 'stage') {
    const s = signerInput(body.principal, body.key);
    if ('error' in s) return s;
    if ((now.signers ?? []).some((l) => l.principal === s.principal && l.keyType === 'ssh-ed25519' && l.key === s.key)) return { error: `${s.principal} with this key (${s.fingerprint}) is already a signer, listed in ${now.signersFile}`, status: 409 };
    if (now.pending.some((e) => e.principal === s.principal && e.key === s.key)) return { error: `${s.principal} with this key (${s.fingerprint}) is already staged: it waits for ${s.confirm}`, status: 409 };
    if (now.pending.length >= now.pendingMax) return { error: `${now.pendingMax} signers are already staged: confirm or discard one first`, status: 409 };
    return {
      ...plan(
        'stage',
        ['stage-update-signer', s.principal, 'ssh-ed25519', s.key],
        [
          `stages this principal and key in ${PENDING_SIGNERS}, for 24 hours`,
          `changes nothing in ${ALLOWED_SIGNERS}: a staged key is trusted for nothing, and no release signed with it installs`,
          `it becomes a signer only when an admin runs, as root on this machine: ${s.confirm}`,
        ],
        now.script.signer.replace('<principal>', s.principal).replace('<public key>', s.key),
      ),
      signer: { ...s, file: ALLOWED_SIGNERS },
    };
  }
  if (body.step === 'discard') {
    const e = now.pending.find((x) => x.principal === body.principal && x.key === body.key);
    if (!e) return { error: "that signer isn't staged (or its 24 hours have passed)", status: 409 };
    return plan('discard', ['discard-update-signer', e.principal, 'ssh-ed25519', e.key], [`takes ${e.principal} (${e.fingerprint}) out of ${PENDING_SIGNERS}: its confirming command then finds nothing`, `changes nothing in ${ALLOWED_SIGNERS}`], '');
  }
  return { error: 'step is install, release, stage or discard' };
}
