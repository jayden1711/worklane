// Release tags are signed with a key the owner provides (SSH or GPG); the release script never makes or
// stores one. Pure: the script reads the git config and passes it here.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';

const SETUP = [
  'Release tags are signed with your own key; nothing is generated for you. Set one up, then run this again:',
  '',
  '  SSH key (also what the release-channel updater verifies):',
  '    git config --global gpg.format ssh',
  '    git config --global user.signingkey ~/.ssh/id_ed25519.pub',
  '',
  '  or a GPG key:',
  '    git config --global user.signingkey <your key id>',
  '',
  'and add that public key to GitHub as a signing key (Settings > SSH and GPG keys > New SSH key, type: Signing Key).',
].join('\n');

/** Why tags can't be signed with this git config ({ 'gpg.format', 'user.signingkey' }), or null when they can. */
export function signingProblem(cfg, fileExists = existsSync) {
  const format = cfg['gpg.format'] || 'openpgp';
  const key = cfg['user.signingkey'] || '';
  if (!key) return `no signing key configured (user.signingkey is empty).\n\n${SETUP}`;
  if (format === 'ssh' && !key.startsWith('key::')) {
    const file = key.replace(/^~(?=\/)/, homedir());
    if (!fileExists(file)) return `user.signingkey names ${key}, which doesn't exist.\n\n${SETUP}`;
  }
  if (format !== 'ssh' && format !== 'openpgp') return `gpg.format ${format} isn't supported for release tags (ssh or openpgp).\n\n${SETUP}`;
  return null;
}

/** Whether git can check the tag's signature here: GPG always; SSH only with an allowed signers file configured. */
export function canVerify(cfg) {
  return (cfg['gpg.format'] || 'openpgp') !== 'ssh' || !!cfg['gpg.ssh.allowedsignersfile'];
}

/**
 * The allowed-signers file a release tag is verified against, or why there is none (SSH only; GPG checks its keyring).
 * The repo's own `repoSigners` (.github/release-signers, what CI checks the pushed tag against) comes first, then the
 * configured gpg.ssh.allowedSignersFile. A release never tags without one: the tag must verify before it's reported.
 */
export function releaseSigners(cfg, repoSigners, fileExists = existsSync) {
  if ((cfg['gpg.format'] || 'openpgp') !== 'ssh') return { file: null, problem: null };
  if (repoSigners && fileExists(repoSigners)) return { file: repoSigners, problem: null };
  const own = (cfg['gpg.ssh.allowedsignersfile'] || '').replace(/^~(?=\/)/, homedir());
  if (own && fileExists(own)) return { file: own, problem: null };
  const why = own ? `gpg.ssh.allowedSignersFile names ${own}, which doesn't exist` : 'no allowed-signers file to verify the tag against';
  return {
    file: null,
    problem: [
      `${why}. A release tag is verified before it's reported, never left unverified. Set one up, then run this again:`,
      '',
      '  echo "release-signer namespaces=\"git\" $(cat ~/.ssh/id_ed25519.pub)" > ~/.ssh/allowed_signers',
      '  git config --global gpg.ssh.allowedSignersFile ~/.ssh/allowed_signers',
      '',
      '(or release from a checkout whose .github/release-signers holds your key).',
    ].join('\n'),
  };
}
