#!/usr/bin/env node
// The parts of the engine updater's setup that only an admin at a root shell does, run by scripts/setup/updates.sh
// (never by the machine helper, never through a coordinator's sudo rule: no rule names this file):
//
//   updates-root.cjs channel release|main                               updates.sh --channel
//   updates-root.cjs add-signer <principal> ssh-ed25519 <public key>    updates.sh --signer
//   updates-root.cjs confirm-signer SHA256:<fingerprint>                updates.sh --confirm-signer
//   updates-root.cjs acknowledge-signers                                updates.sh --acknowledge-signers
//   updates-root.cjs release-hold                                       updates.sh --release-hold
//   updates-root.cjs add-checks <name> [<name> ...]                     updates.sh --add-check <name> ...
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
// The updater hashes the signers file on every run and reports any change it wasn't told about
// (scripts/machine/worklane-update.cjs, "the signers file, watched"). So an append here records the file's new hash
// in the same step, which makes it the one expected kind of change; and acknowledge-signers is how an admin says an
// unexplained change has been looked at, which lifts the hold on release installs.
//
// release-hold is the one way to release a hold the updater put on an engine commit (it was rolled back): it shows
// what was held and why, moves the hold file aside (update-held.released.json, kept), and logs it. Nothing a
// coordinator or the dashboard can run releases a hold: not set-updates, not set-update-channel.
//
// add-checks appends names to updates.json's required_checks and does nothing else: no name there is removed or
// moved, no other key is touched, and every byte of the file stays as it was but the new entries (spliced into the
// list's own text, never a re-serialised file). A name already listed is reported and skipped. Written to a dotted
// temp file beside it with the file's own owner and mode, then renamed over it.
//
// Every signer added, by either route, is one line in the machine change log (/var/lib/worklane/machine-changes.jsonl,
// what: updates.allowed_signers), which the watchdog turns into an alert on the ops channel and the Health page.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const helper = require('../machine/worklane-machine.cjs');
const watch = require('../machine/worklane-update.cjs');

// Fixed paths: none comes from the caller.
const ETC = '/etc/worklane';
const LOG = '/var/lib/worklane/machine-changes.jsonl';
const SIGNERS = 'allowed_signers'; // in ETC
const PENDING = helper.PENDING;
const SIGNERS_STATE = watch.SIGNERS_STATE; // the updater's record of the signers file's hash
const HELD = '/var/lib/worklane/update-held.json'; // the updater's: the rolled-back commit it won't retry

const USAGE = 'usage: updates-root.cjs [check] channel release|main | add-signer <principal> ssh-ed25519 <public key> | confirm-signer SHA256:<fingerprint> | acknowledge-signers | release-hold | add-checks <name> [<name> ...]';
const UPDATES = 'updates.json'; // in ETC

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

/**
 * A check name split at a comma by the old comma-splitting --checks ("test (macos-latest" and "22)"): its parentheses
 * don't pair up. Such a name never matches a real check, so the updater would wait forever. updates.sh's warning about
 * an existing file uses this too.
 */
const unbalanced = (n) => (n.match(/\(/g) || []).length !== (n.match(/\)/g) || []).length;

/** Why a check name can't be added, or null when it can. The updater compares names exactly. */
function checkNameProblem(n) {
  if (typeof n !== 'string' || n.trim() === '') return 'is empty';
  // C0 controls (a newline among them), DEL and C1 controls: never in a check's name, and a newline would split it.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(n)) return 'has a newline or another control character';
  if (n !== n.trim()) return 'starts or ends with a space (the updater compares names exactly)';
  if (unbalanced(n)) return 'has unbalanced parentheses (a name split at a comma?); pass the whole name, quoted';
  return null;
}

/** What an argument list asks for, or null when it is none of the exact forms. */
function parse(args) {
  if (args.length === 2 && args[0] === 'channel' && (args[1] === 'release' || args[1] === 'main')) return { kind: 'channel', channel: args[1] };
  if (args[0] === 'add-signer') {
    const s = helper.parseSigner('add-signer', args);
    return s ? { kind: 'add', ...s } : null;
  }
  if (args.length === 2 && args[0] === 'confirm-signer' && fingerprintShape(args[1])) return { kind: 'confirm', fingerprint: args[1] };
  if (args.length === 1 && args[0] === 'acknowledge-signers') return { kind: 'acknowledge' };
  if (args.length === 1 && args[0] === 'release-hold') return { kind: 'release-hold' };
  if (args.length >= 2 && args[0] === 'add-checks') {
    const bad = args.slice(1).map((n) => [n, checkNameProblem(n)]).filter(([, why]) => why);
    return bad.length ? { kind: 'bad-checks', bad } : { kind: 'add-checks', names: args.slice(1) };
  }
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
  const next = `${before}${before && !before.endsWith('\n') ? '\n' : ''}${line}\n`;
  // The updater is told the hash the file is about to have, but only when the file is as it last recorded it: a
  // change it hasn't been told about is never covered by this one, and it reports the whole of it on its next run.
  const expected = watch.expectSigners(file, `sha256:${require('node:crypto').createHash('sha256').update(next).digest('hex')}`, SIGNERS_STATE);
  const tmp = path.join(ETC, `.${SIGNERS}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, next, { mode: 0o644 });
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, file);
  if (expected) watch.recordSigners(file, SIGNERS_STATE);
  else process.stderr.write(`note: ${file} had already changed since the updater last recorded it; the updater will report that on its next run\n`);
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

/** One line from stdin (the admin's terminal, or what was piped in), at most 300 characters; null when there is none. */
function typedLine(prompt) {
  process.stderr.write(prompt);
  const one = Buffer.alloc(1);
  let s = '';
  for (;;) {
    let n;
    try {
      n = fs.readSync(0, one, 0, 1, null);
    } catch (e) {
      if (e && e.code === 'EAGAIN') continue;
      return s ? s.trim() : null;
    }
    if (n === 0 || one[0] === 0x0a || s.length > 300) break;
    s += one.toString('latin1');
  }
  return s.trim();
}

/** Apply the staged signer with this fingerprint: shown first, then added, then taken out of the pending list. */
function confirmSigner(fingerprint) {
  const s = staged(fingerprint);
  if (s.error) {
    process.stderr.write(`${s.error}\n`);
    return 1;
  }
  const e = s.entry;
  process.stdout.write(`the staged signer, staged by ${e.by}${e.instance ? ` (instance ${e.instance})` : ''} at ${e.at}:\n  principal:   ${e.principal}\n  public key:  ssh-ed25519 ${e.key}\n  fingerprint: ${e.fingerprint}\n`);
  // The fingerprint names the key; the principal, typed here, says the admin read what they are trusting.
  const typed = typedLine(`Type the principal to add it (anything else, or nothing, adds nothing): `);
  if (typed !== e.principal) {
    process.stderr.write(`the principal typed (${JSON.stringify(typed === null ? '' : typed).slice(0, 80)}) isn't the staged signer's (${e.principal}): nothing was added\n`);
    return 1;
  }
  const rc = addSigner({ principal: e.principal, key: e.key }, `confirmed at a root shell; staged by ${e.by}`);
  if (rc !== 0) return rc;
  helper.writePending(helper.readPending(PENDING).filter((x) => !(x.principal === e.principal && x.key === e.key)), PENDING);
  return 0;
}

/** Release the updater's hold on a rolled-back commit: shown, moved aside (kept), logged. */
function releaseHold() {
  let held;
  try {
    held = JSON.parse(fs.readFileSync(HELD, 'utf8'));
  } catch {
    process.stdout.write(`nothing is held (no ${HELD})\n`);
    return 0;
  }
  const what = `${String(held.sha || 'unknown').slice(0, 12)}, rolled back at ${held.at}${Array.isArray(held.failed) && held.failed.length ? ` (${held.failed.join('; ')})` : ''}`;
  process.stdout.write(`held: ${what}\n`);
  fs.renameSync(HELD, HELD.replace(/\.json$/, '.released.json'));
  logLine('updates.hold_released', what, null);
  process.stdout.write(`released: the updater may try ${String(held.sha || 'it').slice(0, 12)} again on its next run\n`);
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

const WS = ' \t\n\r';
/** Past any JSON whitespace from i. */
const skipWs = (t, i) => {
  while (i < t.length && WS.includes(t[i])) i++;
  return i;
};

/** The end (exclusive) of the JSON value that starts at i. */
function valueEnd(t, i) {
  if (t[i] === '"') {
    for (i++; i < t.length; i++) {
      if (t[i] === '\\') i++;
      else if (t[i] === '"') return i + 1;
    }
    throw new Error('an unterminated string');
  }
  if (t[i] === '{' || t[i] === '[') {
    let depth = 0;
    for (; i < t.length; i++) {
      if (t[i] === '"') i = valueEnd(t, i) - 1;
      else if (t[i] === '{' || t[i] === '[') depth++;
      else if ((t[i] === '}' || t[i] === ']') && --depth === 0) return i + 1;
    }
    throw new Error('an unclosed object or list');
  }
  const m = /^[^\s,\]}]+/.exec(t.slice(i));
  if (!m) throw new Error(`no value at offset ${i}`);
  return i + m[0].length;
}

/** Where the top-level "required_checks" value is in the text (the last one, as JSON.parse takes it), or null. */
function requiredChecksSpan(t) {
  let i = skipWs(t, 0);
  if (t[i] !== '{') return null;
  let span = null;
  i = skipWs(t, i + 1);
  while (i < t.length && t[i] !== '}') {
    const keyEnd = valueEnd(t, i);
    const key = JSON.parse(t.slice(i, keyEnd));
    i = skipWs(t, keyEnd);
    if (t[i] !== ':') throw new Error(`no ':' after ${JSON.stringify(key)}`);
    i = skipWs(t, i + 1);
    const end = valueEnd(t, i);
    if (key === 'required_checks') span = { start: i, end };
    i = skipWs(t, end);
    if (t[i] === ',') i = skipWs(t, i + 1);
  }
  return span;
}

/**
 * The file's text with these names appended to its required_checks list, each set off from the one before as the
 * list's last entry is (on a line of its own, indented the same, in a laid-out file; after ", " or "," in a one-line
 * one), and every other byte as it was. Checked before it is returned: it parses to the same object with only these
 * names appended, and taking the inserted text back out gives the original byte for byte.
 */
function withChecks(text, names) {
  const span = requiredChecksSpan(text);
  if (!span || text[span.start] !== '[') throw new Error('no required_checks list');
  // Each entry's start and end in the text.
  const entries = [];
  let i = skipWs(text, span.start + 1);
  while (text[i] !== ']') {
    const end = valueEnd(text, i);
    entries.push({ start: i, end });
    i = skipWs(text, end);
    if (text[i] === ',') i = skipWs(text, i + 1);
  }
  let at;
  let insert;
  if (entries.length === 0) {
    at = span.start + 1;
    insert = names.map((n) => JSON.stringify(n)).join(', ');
  } else {
    const last = entries[entries.length - 1];
    // What comes between the token before the last entry ("[" or ",") and that entry: its layout.
    let j = last.start;
    while (j > span.start && WS.includes(text[j - 1])) j--;
    const sep = text.slice(j, last.start);
    at = last.end;
    insert = names.map((n) => `,${sep}${JSON.stringify(n)}`).join('');
  }
  const next = text.slice(0, at) + insert + text.slice(at);
  const was = JSON.parse(text);
  if (JSON.stringify(JSON.parse(next)) !== JSON.stringify({ ...was, required_checks: [...was.required_checks, ...names] })) throw new Error('the edit would change more than the list');
  if (next.slice(0, at) + next.slice(at + insert.length) !== text) throw new Error('the edit would change other bytes');
  return next;
}

/** Append these check names to updates.json's required_checks; one already there is said and skipped. */
function addChecks(names) {
  const file = path.join(ETC, UPDATES);
  let st;
  try {
    st = fs.lstatSync(file);
  } catch {
    process.stderr.write(`${file} doesn't exist: install the updater first (sudo bash scripts/setup/updates.sh, without --add-check), then run --add-check again. Nothing was changed.\n`);
    return 1;
  }
  if (!st.isFile()) {
    process.stderr.write(`${file} isn't a regular file; nothing was changed\n`);
    return 1;
  }
  const text = fs.readFileSync(file, 'utf8');
  let cfg;
  try {
    cfg = JSON.parse(text);
  } catch (e) {
    process.stderr.write(`${file} isn't valid JSON (${e.message}); nothing was changed\n`);
    return 1;
  }
  const before = cfg && typeof cfg === 'object' && !Array.isArray(cfg) ? cfg.required_checks : undefined;
  if (!Array.isArray(before) || !before.every((n) => typeof n === 'string')) {
    process.stderr.write(`${file} has no required_checks list of names; nothing was changed (remove the file and run updates.sh to write a new one)\n`);
    return 1;
  }
  const show = (l) => l.map((n) => `  ${JSON.stringify(n)}\n`).join('') || '  (none)\n';
  process.stdout.write(`${file} required_checks before:\n${show(before)}`);
  const add = [];
  for (const n of names) {
    if (before.includes(n) || add.includes(n)) process.stdout.write(`already listed, skipped: ${JSON.stringify(n)}\n`);
    else add.push(n);
  }
  if (add.length === 0) {
    process.stdout.write('nothing to add; the file is unchanged\n');
    return 0;
  }
  let next;
  try {
    next = withChecks(text, add);
  } catch (e) {
    process.stderr.write(`${file}: can't add to its required_checks in place (${e.message}); nothing was changed\n`);
    return 1;
  }
  // The new text in full in a dotted temp file beside it, with the file's own owner and mode, then renamed over it:
  // the updater, reading at any moment, sees the old file or the new one, never part of one. A fresh name each time
  // ('wx': never an existing file), since this script removes nothing: a failed write leaves it, and says where.
  const tmp = path.join(ETC, `.${UPDATES}.tmp-${process.pid}-${require('node:crypto').randomBytes(4).toString('hex')}`);
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, next);
      fs.fchownSync(fd, st.uid, st.gid);
      fs.fchmodSync(fd, st.mode & 0o7777);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
  } catch (e) {
    const left = fs.existsSync(tmp) ? ` (the unfinished new one is left at ${tmp}; delete it)` : '';
    process.stderr.write(`${file}: writing it failed (${e.message}); it is as it was${left}\n`);
    return 1;
  }
  logLine('updates.required_checks', null, `added ${add.map((n) => JSON.stringify(n)).join(', ')}`);
  for (const n of add) process.stdout.write(`added: ${JSON.stringify(n)}\n`);
  process.stdout.write(`${file} required_checks after:\n${show([...before, ...add])}`);
  return 0;
}

/** An admin has looked at the signers file as it is: it becomes the updater's record, and release installs are no longer held. */
function acknowledgeSigners() {
  const file = path.join(ETC, SIGNERS);
  const now = watch.signersDigest(file);
  process.stdout.write(`${file} as it is now: ${now.hash}, ${now.lines} signer line${now.lines === 1 ? '' : 's'}\n${now.fingerprints.map((f) => `  ${f}\n`).join('')}`);
  const held = watch.acknowledgeSigners(file, SIGNERS_STATE);
  if (!held) {
    process.stdout.write('nothing was held; recorded as it is\n');
    return 0;
  }
  logLine('updates.signers_acknowledged', watch.signersChangeText(held), now.hash);
  process.stdout.write(`acknowledged: ${watch.signersChangeText(held)}\nrelease installs are no longer held\n`);
  return 0;
}

function main(args) {
  const check = args[0] === 'check';
  const p = parse(check ? args.slice(1) : args);
  if (!p) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  if (p.kind === 'bad-checks') {
    for (const [n, why] of p.bad) process.stderr.write(`--add-check ${JSON.stringify(n)}: the name ${why}. Nothing was changed.\n`);
    return 2;
  }
  if (check) {
    // A confirm is acceptable only while its signer is staged: said before updates.sh installs anything.
    if (p.kind !== 'confirm') return 0;
    const s = staged(p.fingerprint);
    if (s.error) process.stderr.write(`${s.error}\n`);
    return s.error ? 1 : 0;
  }
  if (p.kind === 'acknowledge') return acknowledgeSigners();
  if (p.kind === 'release-hold') return releaseHold();
  if (p.kind === 'channel') return setChannel(p.channel);
  if (p.kind === 'add-checks') return addChecks(p.names);
  if (p.kind === 'add') return addSigner(p, 'updates.sh --signer');
  return confirmSigner(p.fingerprint);
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parse, fingerprintShape, unbalanced, checkNameProblem, withChecks, addChecks };
