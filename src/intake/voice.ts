// Voice as an intake source, exactly like the Discord bot: a spoken idea the owner confirmed on the dashboard is left
// in the voice inbox (the dashboard's POST /api/voice/intake writes it, as the Ask panel leaves a chat request), and
// this source hands it to the coordinator's intake pass, which takes it through the same redaction, caps, triage run,
// policy and approval as a Discord message (src/coordinator/intake.ts intakeReport; nothing here is a second path).
// Its sender is the owner's GitHub login, under the source `voice`: never trusted (intake.yaml has no trusted voice
// senders), so what triage drafts waits for an owner's approval like an untrusted Discord sender's. A file leaves the
// inbox only once the coordinator recorded it (ack), so a restart in between takes it again and the seen ledger
// takes it once. Off unless intake.yaml voice.enabled.
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { groupOnlyDir } from '../os/index.js';
import { loadIntakeConfig } from './config.js';
import { VOICE_MAX_CHARS, voiceInboxDir } from '../voice.js';
import type { IncomingReport, IntakeSource } from './report.js';

const ID = /^[0-9]{13}-[a-f0-9]{8}$/;

interface VoiceFile {
  v: 1;
  id: string;
  at: string;
  /** The owner who spoke and confirmed it (their GitHub login, as the dashboard identified them). */
  by: string;
  text: string;
}

/** Leave a confirmed spoken idea for the coordinator. Returns its id. The caller has checked who and how. */
export function submitVoiceIntake(o: { stateDir: string; text: string; by: string; now?: Date }): { id: string } {
  const text = o.text.trim();
  if (!text) throw new Error('nothing was said');
  if (text.length > VOICE_MAX_CHARS) throw new Error(`the idea is over ${VOICE_MAX_CHARS} characters`);
  const now = o.now ?? new Date();
  const id = `${now.getTime()}-${randomBytes(4).toString('hex')}`;
  const dir = voiceInboxDir(o.stateDir);
  groupOnlyDir(dir);
  const file: VoiceFile = { v: 1, id, at: now.toISOString(), by: o.by, text };
  const tmp = join(dir, `.${id}.tmp`);
  writeFileSync(tmp, JSON.stringify(file), { mode: 0o600 });
  renameSync(tmp, join(dir, `${id}.json`));
  return { id };
}

/** The voice inbox as the coordinator's intake source. */
export class VoiceIntake {
  readonly name = 'voice' as const;
  constructor(private o: { stateDir: string }) {}

  async take(): Promise<IncomingReport[]> {
    const dir = voiceInboxDir(this.o.stateDir);
    if (!existsSync(dir)) return [];
    const out: IncomingReport[] = [];
    for (const f of readdirSync(dir).sort()) {
      const id = f.endsWith('.json') ? f.slice(0, -'.json'.length) : '';
      if (!ID.test(id)) continue;
      let v: Partial<VoiceFile>;
      try {
        v = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Partial<VoiceFile>;
      } catch {
        continue;
      }
      if (v.id !== id || typeof v.by !== 'string' || !v.by || typeof v.text !== 'string' || !v.text.trim() || typeof v.at !== 'string') continue;
      // No thread: a voice report gets no chat reply; its outcome shows on the dashboard's Intake page.
      out.push({ source: 'voice', sourceId: id, sender: { source: 'voice', id: v.by }, text: v.text.slice(0, VOICE_MAX_CHARS), receivedAt: v.at });
    }
    return out;
  }

  async ack(ids: string[]): Promise<void> {
    for (const id of ids) if (ID.test(id)) rmSync(join(voiceInboxDir(this.o.stateDir), `${id}.json`), { force: true });
  }

  /** Spoken ideas have no thread to reply into. */
  async reply(): Promise<boolean> {
    return false;
  }

  source(): IntakeSource {
    return { name: this.name, take: () => this.take(), ack: (ids) => this.ack(ids), reply: () => this.reply() };
  }
}

/**
 * Why the instance takes no spoken ideas, or null when it does: its intake.yaml (in the instance home) exists, is
 * valid and has voice.enabled. Read on every request, as the coordinator reads it on every pass.
 */
export function voiceIntakeRefusal(intakeFile: string | undefined): string | null {
  const c = intakeFile ? loadIntakeConfig(intakeFile) : null;
  if (!c) return 'intake is off for this instance (no intake.yaml), so spoken ideas go nowhere';
  if ('error' in c) return 'intake.yaml is refused (run `intake check`), so intake is off';
  if (!c.config.voice.enabled) return 'voice intake is off for this instance (intake.yaml voice.enabled)';
  return null;
}
