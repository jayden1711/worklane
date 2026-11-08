import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog } from '../src/events/log.js';
import { CHECKPOINT_EVERY_MS, GENESIS, chainFileFor, checkpoint, readCheckpoints, verify } from '../src/audit-chain.js';
import { auditCommand } from '../src/audit-chain-cli.js';
import { Coordinator } from '../src/coordinator.js';
import { FakeRunner } from '../src/runner.js';
import { coordinator, fixture as coordFixture, skip } from './repro-state-graph/harness.js';

const posix = process.platform !== 'win32';

/** A log in a directory of its own with an agent run, a merge and a dashboard write: the kinds of action audited. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'audit-chain-'));
  const db = join(dir, 'events.db');
  const log = new EventLog(db);
  const add = () => {
    log.append('run.started', { issue: 1, role: 'worker', model: 'm', worktree: '/w', pid: 10, pgid: 10, attempt: 1 }, 'coordinator');
    log.append('merge.decided', { issue: 1, number: 7, head: 'a'.repeat(40), auto: true, reasons: [] }, 'coordinator');
    log.append('dashboard.audit', { login: 'someone', role: 'owner', via: 'session', instance: null, action: 'clear', detail: {} }, 'someone', 'human');
  };
  return { dir, db, log, file: chainFileFor(db), add, done: () => (log.close(), rmSync(dir, { recursive: true, force: true })) };
}

/** Change a stored row the way only the file's owner can: drop the trigger, then write. */
function tamper(log: EventLog, sql: string) {
  log.db.exec('DROP TRIGGER IF EXISTS events_no_update; DROP TRIGGER IF EXISTS events_no_delete;');
  log.db.exec(sql);
}

test('audit chain: checkpoints cover every event; verify recomputes the chain and reports the head and what is not yet covered', () => {
  const f = fixture();
  try {
    assert.equal(checkpoint({ db: f.log.db, file: f.file }), null, 'nothing to checkpoint in an empty log');
    f.add();
    const c1 = checkpoint({ db: f.log.db, file: f.file })!;
    assert.equal(c1.event, f.log.lastId());
    assert.equal(c1.prev, GENESIS);
    assert.equal(checkpoint({ db: f.log.db, file: f.file }), null, 'no new events: no new line');
    f.add();
    const c2 = checkpoint({ db: f.log.db, file: f.file })!;
    assert.notEqual(c2.head, c1.head);
    f.add();
    const r = verify({ db: f.log.db, file: f.file });
    assert.deepEqual(r, { ok: true, checkpoints: 2, event: c2.event, head: c2.head, uncovered: 3, anchored: false });
    assert.equal(verify({ db: f.log.db, file: f.file, anchor: c1.head }).ok, true);
    if (posix) assert.equal(statSync(f.file).mode & 0o007, 0, 'the checkpoint file is not world-readable');
  } finally {
    f.done();
  }
});

test('audit chain: a changed event (its payload, actor, type or time) fails verify, naming the range it is in', () => {
  for (const col of ["payload = '{}'", "actor = 'nobody'", "type = 'run.heartbeat'", "ts = '2000-01-01T00:00:00.000Z'"]) {
    const f = fixture();
    try {
      f.add();
      const c1 = checkpoint({ db: f.log.db, file: f.file })!;
      f.add();
      checkpoint({ db: f.log.db, file: f.file });
      tamper(f.log, `UPDATE events SET ${col} WHERE id = ${c1.event + 2}`);
      const r = verify({ db: f.log.db, file: f.file });
      assert.equal(r.ok, false, col);
      assert.match((r as { why: string }).why, new RegExp(`checkpoint 2 of 2 .*after event ${c1.event}`), col);
    } finally {
      f.done();
    }
  }
});

test('audit chain: a removed event, or one inserted under an old id, fails verify', () => {
  const f = fixture();
  try {
    f.add();
    checkpoint({ db: f.log.db, file: f.file });
    tamper(f.log, 'DELETE FROM events WHERE id = 2');
    assert.equal(verify({ db: f.log.db, file: f.file }).ok, false, 'removed from the middle');
    f.log.db.exec("INSERT INTO events (id, ts, type, actor, source, payload) VALUES (2, '2026-01-01T00:00:00.000Z', 'merge.decided', 'coordinator', 'coordinator', '{}')");
    assert.equal(verify({ db: f.log.db, file: f.file }).ok, false, 'put back with other content');
    tamper(f.log, `DELETE FROM events WHERE id = ${f.log.lastId()}`);
    assert.match((verify({ db: f.log.db, file: f.file }) as { why: string }).why, /is not in the log/, 'the last covered event removed');
  } finally {
    f.done();
  }
});

test('audit chain: a checkpoint line changed or removed from the middle fails verify; a cut tail fails only against the anchor', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 3; i++) {
      f.add();
      checkpoint({ db: f.log.db, file: f.file });
    }
    const lines = readFileSync(f.file, 'utf8').trimEnd().split('\n');
    const kept = verify({ db: f.log.db, file: f.file });
    assert.equal(kept.ok, true);
    const head = (kept as { head: string }).head;

    writeFileSync(f.file, `${[lines[0], lines[2]].join('\n')}\n`);
    assert.match((verify({ db: f.log.db, file: f.file }) as { why: string }).why, /does not chain to the line before it/);

    const edited = JSON.parse(lines[1]!);
    edited.at = '2000-01-01T00:00:00.000Z';
    writeFileSync(f.file, `${[lines[0], JSON.stringify(edited), lines[2]].join('\n')}\n`);
    assert.equal(verify({ db: f.log.db, file: f.file }).ok, false, 'an edited line breaks the next line\'s link');

    writeFileSync(f.file, `${lines.slice(0, 2).join('\n')}\n`);
    assert.equal(verify({ db: f.log.db, file: f.file }).ok, true, 'a cut tail looks whole on its own');
    assert.match((verify({ db: f.log.db, file: f.file, anchor: head }) as { why: string }).why, /no checkpoint's head/);

    writeFileSync(f.file, 'not json\n');
    assert.match((verify({ db: f.log.db, file: f.file }) as { why: string }).why, /line 1 is not JSON/);
    assert.match((verify({ db: f.log.db, file: f.file, anchor: 'abc' }) as { why: string }).why, /not a head/);
  } finally {
    f.done();
  }
});

test('audit chain: the chain is over the stored text, so a backup (VACUUM INTO) verifies against the same checkpoints', () => {
  const f = fixture();
  try {
    f.add();
    checkpoint({ db: f.log.db, file: f.file });
    const copy = join(f.dir, 'backup.db');
    f.log.db.exec(`VACUUM INTO '${copy}'`);
    const b = new EventLog(copy);
    try {
      assert.equal(verify({ db: b.db, file: f.file }).ok, true);
    } finally {
      b.close();
    }
  } finally {
    f.done();
  }
});

test('the coordinator checkpoints the chain beside its events database at most every 10 minutes', () => {
  const f = fixture();
  try {
    f.add();
    const c = { d: { log: f.log }, auditCheckpointAt: 0 } as unknown as Coordinator;
    const at = 1_000_000_000_000;
    Coordinator.prototype.checkpointAudit.call(c, at);
    assert.equal(readCheckpoints(f.file).checkpoints.length, 1);
    f.add();
    Coordinator.prototype.checkpointAudit.call(c, at + CHECKPOINT_EVERY_MS - 1);
    assert.equal(readCheckpoints(f.file).checkpoints.length, 1, 'not again within 10 minutes');
    Coordinator.prototype.checkpointAudit.call(c, at + CHECKPOINT_EVERY_MS);
    assert.equal(readCheckpoints(f.file).checkpoints.length, 2);
    assert.equal(verify({ db: f.log.db, file: f.file }).ok, true);
  } finally {
    f.done();
  }
});

test('audit verify / checkpoint: exit 0 verified, 1 FAILED with why, 2 a usage error', () => {
  const f = fixture();
  const out: string[] = [];
  const err: string[] = [];
  const run = (sub: string | undefined, ...a: string[]) => auditCommand(sub, a, (s) => out.push(s), (s) => err.push(s));
  try {
    f.add();
    f.log.close();
    assert.equal(run('checkpoint', '--log', f.db), 0);
    assert.match(out.at(-1)!, /^checkpoint: event \d+, head [0-9a-f]{64}$/);
    assert.equal(run('verify', '--log', f.db), 0);
    assert.match(out.join('\n'), /verified: 1 checkpoint\(s\)/);
    assert.equal(run('verify'), 2);
    assert.equal(run('verify', '--log', f.db, '--log', f.db), 2);
    assert.equal(run('verify', '--log', f.db, '--key', 'x'), 2);
    assert.equal(run('nope', '--log', f.db), 2);
    assert.equal(run('checkpoint', '--log', f.db, '--anchor', GENESIS), 2, 'checkpoint takes no anchor');
    assert.equal(run('verify', '--log', f.db, '--anchor', 'f'.repeat(64)), 1);
    assert.match(err.at(-1)!, /^FAILED: the anchor/);
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test("a coordinator tick writes the chain's checkpoint beside its events database, and it verifies", { skip }, async () => {
  const f = coordFixture();
  try {
    const c = coordinator(f, new FakeRunner(() => ({ structured: { summary: 's' } })));
    await c.tick();
    await c.idle();
    const file = chainFileFor(f.log.path);
    assert.equal(readCheckpoints(file).checkpoints.length, 1, 'the first tick checkpoints');
    assert.equal(verify({ db: f.log.db, file }).ok, true);
  } finally {
    f.log.close();
    rmSync(f.base, { recursive: true, force: true });
  }
});
