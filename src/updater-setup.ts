// The engine updater's setup, for the Machine page's "Updater setup" (the first-run wizard's Updates step, server
// mode): whether the updater is installed, the channel it follows, and the release signers it verifies tags against.
// Read-only here. Each change is one machine helper command (src/machine.ts: install-updater, set-update-channel,
// add-update-signer), reviewed and confirmed by an owner, recorded as a machine request and run by the coordinator
// (src/machine-requests.ts). The signers file is the root of trust for release updates, so the page only ever asks
// for one thing about it: add the one key an owner typed, shown back whole with its fingerprint before the confirm.
// Nothing here removes or replaces a signer, moves the file, or changes how the updater verifies.
import { readFileSync } from 'node:fs';
import { BRAND } from './brand.js';
import { MACHINE_HELPER, signerFingerprint, signerKeyOk, signerPrincipalOk, UPDATE_CHANNELS, type UpdateChannelName } from './machine.js';
import { UPDATES_CONFIG, updateChannel } from './updates.js';

/** The signers file the helper adds to, and the one a new updates.json names. */
export const ALLOWED_SIGNERS = `/etc/${BRAND.cli}/allowed_signers`;
const UPDATES_SCRIPT = 'scripts/setup/updates.sh';

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

export interface SignerToAdd {
  principal: string;
  key: string;
  fingerprint: string;
  /** The line the helper adds, exactly. */
  line: string;
}

/**
 * The signer an owner typed: a principal, and a public key as `ssh-ed25519 AAAA... [comment]` (a .pub file's line) or
 * the key alone. The comment is dropped; nothing else is changed. Or why it can't be added from the page.
 */
export function signerInput(principal: unknown, key: unknown): SignerToAdd | { error: string } {
  const p = typeof principal === 'string' ? principal.trim() : '';
  if (!signerPrincipalOk(p)) return { error: 'the principal is one name of an email\'s shape (release@example.com): no spaces, wildcards, lists or options' };
  const w = (typeof key === 'string' ? key : '').trim().split(/\s+/).filter(Boolean);
  if (w[0] && KEY_TYPE.test(w[0]) && w[0] !== 'ssh-ed25519') return { error: `the page adds ssh-ed25519 keys only, not ${w[0]}: add another kind of key to ${ALLOWED_SIGNERS} at a root shell` };
  const k = w[0] === 'ssh-ed25519' ? w[1] : w.length === 1 ? w[0] : undefined;
  if (!signerKeyOk(k)) return { error: 'the public key is one ssh-ed25519 key: the line of a .pub file (ssh-ed25519 AAAAC3... comment), or its AAAAC3... part alone' };
  return { principal: p, key: k, fingerprint: signerFingerprint(k), line: `${p} ssh-ed25519 ${k}` };
}

export const CHANNEL_WHAT: Record<UpdateChannelName, string> = {
  release: `the newest release tag vX.Y.Z, only when its signature verifies against a key listed in the signers file and its checks are green`,
  main: `main's newest commit whose checks are all green. There is no release tag on this channel, so no tag signature is checked: what main's required checks pass is what gets installed`,
};

export interface UpdaterSetup {
  installed: boolean;
  enabled: boolean | null;
  channel: UpdateChannelName | null;
  channels: { id: UpdateChannelName; what: string }[];
  /** The file the helper adds signers to. */
  signersFile: string;
  /** The file this machine's updates.json tells the updater to read, when it isn't that one (an admin's own setup). */
  updaterReads: string | null;
  /** null: no signers file yet. */
  signers: ListedSigner[] | null;
  /** The same steps without the page: as root, from the engine's checkout. */
  script: { install: string; channel: string; signer: string; signersByHand: string };
}

/** The updater's setup as the page shows it. */
export function updaterSetup(o: { updatesConfigPath?: string; signersPath?: string } = {}): UpdaterSetup {
  let cfg: Record<string, unknown> | null = null;
  try {
    const j = JSON.parse(readFileSync(o.updatesConfigPath ?? UPDATES_CONFIG, 'utf8')) as unknown;
    if (j && typeof j === 'object' && !Array.isArray(j)) cfg = j as Record<string, unknown>;
  } catch {
    // not installed
  }
  const signersFile = o.signersPath ?? ALLOWED_SIGNERS;
  const reads = cfg && typeof cfg.allowed_signers === 'string' ? cfg.allowed_signers : null;
  return {
    installed: !!cfg,
    enabled: cfg ? cfg.enabled === true : null,
    channel: cfg ? updateChannel(cfg) : null,
    channels: UPDATE_CHANNELS.map((id) => ({ id, what: CHANNEL_WHAT[id] })),
    signersFile,
    updaterReads: reads && reads !== ALLOWED_SIGNERS ? reads : null,
    signers: listedSigners(signersFile),
    script: {
      install: `sudo bash ${UPDATES_SCRIPT}`,
      channel: `sudo bash ${UPDATES_SCRIPT} --channel <release|main>`,
      signer: `sudo bash ${UPDATES_SCRIPT} --signer <principal> ssh-ed25519 <public key>`,
      signersByHand: `${ALLOWED_SIGNERS}: one line per key, "<principal> <key type> <public key>" (root:root 0644)`,
    },
  };
}

export type UpdaterStep = 'install' | 'channel' | 'signer';

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
  /** For a signer: exactly what will be written, to confirm. */
  signer?: SignerToAdd & { file: string };
}

/** What one step of the setup would run and change, from what an owner entered; or why it can't. Changes nothing. */
export function updaterPlan(body: { step?: unknown; channel?: unknown; principal?: unknown; key?: unknown }, now: UpdaterSetup): UpdaterPlan | { error: string; status?: 400 | 409 } {
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
  if (body.step === 'channel') {
    const to = body.channel;
    if (to !== 'release' && to !== 'main') return { error: `the channel is one of: ${UPDATE_CHANNELS.join(', ')}` };
    if (!now.installed) return { error: "the updater isn't installed on this machine yet: install it first" };
    if (now.channel === to) return { error: `the channel is already ${to}`, status: 409 };
    return plan(
      'channel',
      ['set-update-channel', to],
      [`sets the channel in ${UPDATES_CONFIG} from "${now.channel}" to "${to}": the updater then follows ${CHANNEL_WHAT[to]}`, `changes nothing else in ${UPDATES_CONFIG}: the required checks, the signers file it names, and whether updates are on stay as they are`, `doesn't touch ${ALLOWED_SIGNERS}`],
      now.script.channel.replace('<release|main>', to),
    );
  }
  if (body.step === 'signer') {
    const s = signerInput(body.principal, body.key);
    if ('error' in s) return s;
    if ((now.signers ?? []).some((l) => l.principal === s.principal && l.keyType === 'ssh-ed25519' && l.key === s.key)) return { error: `${s.principal} with this key (${s.fingerprint}) is already listed in ${now.signersFile}`, status: 409 };
    return {
      ...plan(
        'signer',
        ['add-update-signer', s.principal, 'ssh-ed25519', s.key],
        [
          `adds one line to ${ALLOWED_SIGNERS}: release tags signed with this key, as this principal, will verify`,
          now.signers?.length ? `keeps the ${now.signers.length} signer${now.signers.length === 1 ? '' : 's'} already listed, unchanged` : 'starts the file: no signer is listed yet',
          `changes nothing in ${UPDATES_CONFIG}`,
        ],
        now.script.signer.replace('<principal>', s.principal).replace('<public key>', s.key),
      ),
      signer: { ...s, file: ALLOWED_SIGNERS },
    };
  }
  return { error: 'step is install, channel or signer' };
}
