#!/usr/bin/env node
// The parts of the engine updater's setup that only an admin at a root shell does, run by scripts/setup/updates.sh
// (never by the machine helper, never through a coordinator's sudo rule: no rule names this file):
//
//   updates-root.cjs channel release|main                               updates.sh --channel
//   updates-root.cjs add-signer <principal> ssh-ed25519 <public key>    updates.sh --signer
//   updates-root.cjs confirm-signer SHA256:<fingerprint>                updates.sh --confirm-signer
//   updates-root.cjs check <one of the above...>                        whether it would be accepted; changes nothing
//
// /etc/worklane/allowed_signers lists the keys a release tag's signature is checked against: the root of trust for
// the release channel. This is the only code that writes it, and it only ever adds a line: every byte already in
// the file is kept, in place, and a signer already listed is left alone. Nothing here removes or replaces a signer,
// or changes how the updater verifies.
//
// confirm-signer is the second half of adding a signer from the dashboard. The dashboard can only stage one (the
// machine helper's stage-update-signer: /var/lib/worklane/pending-signers.json, trusted for nothing). An admin then
// runs this on the machine with the fingerprint the page showed. It applies the one staged signer with exactly that
// fingerprint, staged less than 24 hours ago; it prints the principal and the key first; and it takes the entry out
// of the pending list. A fingerprint that matches nothing staged changes nothing.
//
// Every signer added, by either route, is one line in the machine change log (/var/lib/worklane/machine-changes.jsonl,
// what: updates.allowed_signers), which the watchdog turns into an alert on the ops channel and the Health page.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const helper = require('../machine/worklane-machine.cjs');

// Fixed paths: none comes from the caller.
const ETC = '/etc/worklane';
const LOG = '/var/lib/worklane/machine-changes.jsonl';
const SIGNERS = 'allowed_signers'; // in ETC
const PENDING = helper.PENDING;

const USAGE = 'usage: updates-root.cjs [check] channel release|main | add-signer <principal> ssh-ed25519 <public key> | confirm-signer SHA256:<fingerprint>';

/** A SHA256 fingerprint as ssh-keygen prints it: SHA256: and 43 base64 characters. */
const fingerprintShape = (s) => typeof s === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(s);

function logLine(what, from, to, extra = {}) {
  const by = process.env.SUDO_USER || 'root';
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), by, what, from, to, ...extra })}\n`, { mode: 0o644 });
  try {
    execFileSync('logger', ['-t', 'worklane-updates', `${by} ${what}: ${JSON.stringify(to)}`], { stdio: 'ignore' });
  } catch {
    // no journal here (a test, or a machine without logger): the change log still has it
  }
}

/** What an argument list asks for, or null when it is none of the exact forms. */
function parse(args) {
  if (args.length === 2 && args[0] === 'channel' && (args[1] === 'release' || args[1] === 'main')) return { kind: 'channel', channel: args[1] };
  if (args[0] === 'add-signer') {
    const s = helper.parseSigner('add-signer', args);
    return s ? { kind: 'add', ...s } : null;
  }
  if (args.length === 2 && args[0] === 'confirm-signer' && fingerprintShape(args[1])) return { kind: 'confirm', fingerprint: args[1] };
  return null;
}

/**
 * Add one signer line to the allowed signers file. What is there stays, byte for byte, with the new line after it;
 * a line with this principal and key already there changes nothing. Written to a temp file beside it, then renamed.
 * `how` says which way it came (updates.sh --signer, or a staged signer confirmed), for the log and the alert.
 */
function addSigner(s, how) {
  const file = path.join(ETC, SIGNERS);
  const fp = helper.fingerprint(s.key);
  const line = `${s.principal} ssh-ed25519 ${s.key}`;
  let before = '';
  let st = null;
  try {
    st = fs.lstatSync(file);
  } catch {
    // none yet: this is its first line
  }
  if (st) {
    if (!st.isFile()) {
      process.stderr.write(`${file} isn't a regular file; not writing it\n`);
      return 1;
    }
    before = fs.readFileSync(file, 'utf8');
  }
  const listed = before.split('\n').map((l) => l.trim().split(/\s+/));
  if (listed.some((w) => w[0] === s.principal && w.at(-2) === 'ssh-ed25519' && w.at(-1) === s.key)) {
    process.stdout.write(`${file}: ${line} (${fp}) is already listed; nothing changed\n`);
    return 0;
  }
  const tmp = path.join(ETC, `.${SIGNERS}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${line}\n`, { mode: 0o644 });
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, file);
  logLine('updates.allowed_signers', null, `added ${line} (${fp})`, { principal: s.principal, fingerprint: fp, how });
  process.stdout.write(`${file}: added ${line} (${fp})\n`);
  return 0;
}

/** The one staged signer with this fingerprint, or why there isn't one. */
function staged(fingerprint) {
  const match = helper.readPending(PENDING).filter((e) => e.fingerprint === fingerprint);
  if (match.length === 1) return { entry: match[0] };
  if (match.length > 1) return { error: `${match.length} staged signers have the fingerprint ${fingerprint} (${match.map((e) => e.principal).join(', ')}): discard all but one from the dashboard, then run this again` };
  return { error: `no staged signer has the fingerprint ${fingerprint}: nothing was added. A staged signer waits 24 hours, then is dropped; stage it again from the dashboard (the Machine page's Updater setup)` };
}

/** Apply the staged signer with this fingerprint: shown first, then added, then taken out of the pending list. */
function confirmSigner(fingerprint) {
  const s = staged(fingerprint);
  if (s.error) {
    process.stderr.write(`${s.error}\n`);
    return 1;
  }
  const e = s.entry;
  process.stdout.write(`the staged signer, from ${e.by} at ${e.at}:\n  principal:   ${e.principal}\n  public key:  ssh-ed25519 ${e.key}\n  fingerprint: ${e.fingerprint}\n`);
  const rc = addSigner({ principal: e.principal, key: e.key }, `confirmed at a root shell; staged by ${e.by}`);
  if (rc !== 0) return rc;
  helper.writePending(helper.readPending(PENDING).filter((x) => !(x.principal === e.principal && x.key === e.key)), PENDING);
  return 0;
}

/** The channel in an installed updater's config, and nothing else in it. */
function setChannel(channel) {
  const file = path.join(ETC, 'updates.json');
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    process.stderr.write(`${file} is missing or unreadable: install the updater first\n`);
    return 1;
  }
  const from = cfg.channel === undefined ? null : cfg.channel;
  const tmp = path.join(ETC, `.updates.json.tmp-${process.pid}`);
  fs.writeFileSync(tmp, `${JSON.stringify({ ...cfg, channel })}\n`, { mode: 0o644 });
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, file);
  logLine('updates.channel', from, channel);
  process.stdout.write(`updates.channel: ${JSON.stringify(from)} -> ${JSON.stringify(channel)}\n`);
  return 0;
}

function main(args) {
  const check = args[0] === 'check';
  const p = parse(check ? args.slice(1) : args);
  if (!p) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (check) {
    // A confirm is acceptable only while its signer is staged: said before updates.sh installs anything.
    if (p.kind !== 'confirm') return 0;
    const s = staged(p.fingerprint);
    if (s.error) process.stderr.write(`${s.error}\n`);
    return s.error ? 1 : 0;
  }
  if (p.kind === 'channel') return setChannel(p.channel);
  if (p.kind === 'add') return addSigner(p, 'updates.sh --signer');
  return confirmSigner(p.fingerprint);
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parse, fingerprintShape };
