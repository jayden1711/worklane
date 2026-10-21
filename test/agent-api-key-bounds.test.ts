// #904 round 4: the API-key login's checks are bounded and trust nothing the coordinator user writes.
// - add-project's agent-run checks can't be held by the agent user: its settings.json or key file as a FIFO, a link or
//   a hard link make the claude-token step wait, at once (timeout -k, no stdin, a non-blocking open of the settings).
// - set-agent-api-key and the setup step other-keys take the agent's home from the user database, never instance.yaml,
//   and only this instance's key place there; other-keys fails closed on a key it can see that isn't the agent's alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from './script-child-process.js';
import { chmodSync, closeSync, constants, linkSync, mkdirSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AGENT, canHide, coordinatorView, engineInstance, KEY, machine, posix, tokenStep } from './api-key-fixtures.js';

/** A FIFO at `path` (the stand-in for an agent user's trap), through mkfifo(1): Node has no call for it. */
function fifo(path: string) {
  rmSync(path, { force: true });
  const r = spawnSync('mkfifo', ['-m', '0600', path], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
}
/** Let anything still blocked reading the FIFO go: open its write end without blocking, then close it (EOF). */
function release(path: string) {
  try {
    closeSync(openSync(path, constants.O_WRONLY | constants.O_NONBLOCK));
  } catch {
    // no reader left
  }
}

/** The bound a test allows add-project's whole run: well past lib.sh's (20 s, then 5 s to kill), well short of a hang. */
const RUN_LIMIT_MS = 60_000;

test("round 4: the agent's settings.json as a FIFO never holds add-project: claude-token waits, at once", { skip: !posix }, () => {
  const m = machine();
  m.keyed();
  fifo(m.settings);
  try {
    const r = m.run(undefined, RUN_LIMIT_MS);
    assert.notEqual(r.signal, 'SIGKILL', `add-project was still running after ${RUN_LIMIT_MS} ms`);
    assert.equal(r.status, 3, r.stderr);
    assert.equal(tokenStep(r.events).state, 'waiting');
    assert.ok(r.ms < 30_000, `took ${r.ms} ms`);
    assert.equal(m.hostCalls(), '', 'no host tool was reached');
  } finally {
    release(m.settings);
  }
});

test('round 4: the key file as a FIFO, a hard link, or the settings as a link: claude-token waits', { skip: !posix }, () => {
  const cases: Record<string, (m: ReturnType<typeof machine>) => string | null> = {
    'the key file is a FIFO': (m) => {
      m.keyed();
      fifo(m.keyFile);
      return m.keyFile;
    },
    "the key file is a hard link to another private file of the agent's (~/.ssh/id_ed25519)": (m) => {
      const f = m.privateFile('.ssh/id_ed25519');
      m.keyed();
      rmSync(m.keyFile);
      linkSync(f, m.keyFile);
      chmodSync(m.keyFile, 0o400);
      return null;
    },
    'the installed key, with a second hard link to it': (m) => {
      m.keyed();
      linkSync(m.keyFile, join(m.agentHome, 'copy-of-key'));
      return null;
    },
    "the agent's settings.json is a link to a file that names the key": (m) => {
      m.keyed();
      const real = join(m.agentHome, 'elsewhere.json');
      writeFileSync(real, `${JSON.stringify({ apiKeyHelper: `cat -- ${m.keyFile}` })}\n`, { mode: 0o600 });
      rmSync(m.settings);
      symlinkSync(real, m.settings);
      return null;
    },
    "the agent's settings.json is over 64 KiB": (m) => {
      m.keyed();
      writeFileSync(m.settings, `${JSON.stringify({ apiKeyHelper: `cat -- ${m.keyFile}`, pad: 'x'.repeat(70_000) })}\n`, { mode: 0o600 });
      return null;
    },
  };
  for (const [why, make] of Object.entries(cases)) {
    const m = machine();
    const trap = make(m);
    try {
      const r = m.run(undefined, RUN_LIMIT_MS);
      assert.notEqual(r.signal, 'SIGKILL', `${why}: still running after ${RUN_LIMIT_MS} ms`);
      assert.equal(r.status, 3, `${why}: ${r.stderr}`);
      assert.equal(tokenStep(r.events).state, 'waiting', why);
      assert.equal(m.hostCalls(), '', `${why}: no host tool was reached`);
    } finally {
      if (trap) release(trap);
    }
  }
});

test("round 4: set-agent-api-key takes the agent's home from the user database, never instance.yaml, and only this instance's key place", { skip: !canHide && 'needs POSIX modes, not as root' }, () => {
  // A missing key of another instance name's directory, in the (hidden) agent home.
  const zzz = engineInstance();
  const zzzKey = join(zzz.agentHome, '.config', 'zzz-claude-key', 'api_key');
  chmodSync(zzz.agentHome, 0o000);
  try {
    const r = zzz.cli('--file', zzzKey);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /not where credentials\.sh <name> api-key installs the key/);
  } finally {
    chmodSync(zzz.agentHome, 0o700);
  }
  assert.equal(readText(zzz.creds), zzz.text, 'credentials.yaml unchanged');

  // instance.yaml names another (hidden) home as the agent's, holding a key at its alpha place: refused, since the
  // user database says the agent's home is elsewhere.
  const forgedHome = join(engineInstance().T, 'forged-home');
  const forged = engineInstance({ yamlHome: forgedHome });
  const forgedKey = join(forgedHome, '.config', 'alpha-claude-key', 'api_key');
  mkdirSync(dirname(forgedKey), { recursive: true });
  writeFileSync(forgedKey, KEY, { mode: 0o400 });
  chmodSync(forgedHome, 0o000);
  try {
    const r = forged.cli('--file', forgedKey);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /not where credentials\.sh <name> api-key installs the key/);
  } finally {
    chmodSync(forgedHome, 0o700);
  }
  assert.equal(readText(forged.creds), forged.text, 'credentials.yaml unchanged');

  // No such agent user in the user database: nothing to install a key for, whatever instance.yaml says.
  const none = engineInstance({ passwdHome: null });
  writeFileSync(none.installed, KEY, { mode: 0o400 });
  chmodSync(none.agentHome, 0o000);
  try {
    const r = none.cli('--file', none.installed);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /no agent user wl-alpha-agent on this machine/);
  } finally {
    chmodSync(none.agentHome, 0o700);
  }
  assert.equal(readText(none.creds), none.text, 'credentials.yaml unchanged');
});

test('round 4: set-agent-api-key refuses a key file with more than one link', { skip: !posix }, () => {
  const e = engineInstance();
  writeFileSync(join(e.T, 'elsewhere'), KEY, { mode: 0o400 });
  linkSync(join(e.T, 'elsewhere'), e.installed);
  const r = e.cli('--file', e.installed);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /has 2 links/);
  assert.equal(readText(e.creds), e.text);
});

test("round 4: other-keys certifies a hidden key only at this instance's place, for this instance's own agent user", { skip: !canHide && 'needs POSIX modes, not as root' }, () => {
  const notInstalled = /not where credentials\.sh <name> api-key installs the key/;
  const cases: Record<string, [object, Parameters<typeof coordinatorView>[1], RegExp]> = {
    'a missing key of another instance name (zzz-claude-key)': [AGENT, { key: (h) => join(h, '.config', 'zzz-claude-key', 'api_key') }, notInstalled],
    "the old name's directory, after a rename (credentials.sh <new> api-key not rerun)": [AGENT, { key: (h) => join(h, '.config', 'old-name-claude-key', 'api_key') }, notInstalled],
    "root's record of another user as shop's agent": [{ ...AGENT, user: 'wl-other-agent' }, {}, /no working API-key login/],
  };
  for (const [why, [record, o, re]] of Object.entries(cases)) {
    const s = coordinatorView(record, o).check();
    assert.equal(s.done, false, `${why}: ${s.detail}`);
    assert.match(s.detail, re, why);
  }
});

test("round 4: other-keys fails closed on a key it can see that isn't the agent's alone", { skip: !posix }, () => {
  const cases: Record<string, [(installed: string) => void, RegExp]> = {
    'a directory at the key place': [(p) => (rmSync(p), mkdirSync(p)), /is not a plain file/],
    "this user's own file, 0644": [(p) => chmodSync(p, 0o644), /this user's own/],
    "this user's own file, 0400": [() => {}, /this user's own/],
    'a link at the key place': [(p) => (rmSync(p), symlinkSync(join(dirname(p), 'x'), p)), /is not a plain file/],
  };
  for (const [why, [make, re]] of Object.entries(cases)) {
    const v = coordinatorView(AGENT, { visible: true, key: (h) => join(h, '.config', 'shop-claude-key', 'api_key') });
    make(v.installed);
    const s = v.check();
    assert.equal(s.done, false, `${why}: ${s.detail}`);
    assert.match(s.detail, re, why);
  }
});

const readText = (f: string): string => readFileSync(f, 'utf8');
