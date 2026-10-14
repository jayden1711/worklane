// The superfans, wired into the coordinator (src/superfan/): with intake.yaml `superfan.enabled` and Discord on, each
// tick starts a pass when one is due, one at a time, in the background. The instance's superfan reads this
// instance's event log, its incidents, its test runs (folded from the log), its health suggestions and its own
// service log (the dashboard's reader, as the coordinator's user: never sudo), and posts in `superfan.channel`.
// With `superfan.machine_channel`, the coordinator also competes for the machine's superfan (a lock in the slot
// directory, held while it lives, like the watchdog's machine role): the machine's incidents and the updater's log,
// posted there. Its model run is a no-tools run on the research lane (an empty directory: nothing to read), its
// prompt the redacted digest only; its posts go through the bot's ordinary channel post, once per key.
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EventPayload } from '../events/types.js';
import { healthView } from '../health.js';
import { threadRunDir } from '../intake/explain.js';
import { redactPii } from '../intake/redact.js';
import { REPLIER_DENIED } from '../intake/replier.js';
import type { IntakeConfig } from '../intake/report.js';
import { tryLock, type Lock } from '../locks.js';
import { slotsDir } from '../os/index.js';
import { RESEARCH_LANE } from '../research.js';
import { superfanPass, SUPERFAN_SYSTEM, VERDICT_SCHEMA, type SuperfanDeps } from '../superfan/superfan.js';
import { updateLog } from '../updates.js';
import { readIncidents } from '../watchdog/incidents.js';
import { scrub } from '../watchdog/post.js';
import { runRoute } from './model-routing.js';
import { Learnings } from './learnings.js';

export const SUPERFAN_ROLE = 'superfan';
/** The machine's superfan's lock and state, in the slot directory every coordinator shares. */
export const MACHINE_LOCK = 'superfan-machine.lock';
export const MACHINE_STATE = 'superfan-machine.json';

export abstract class SuperfanWatch extends Learnings {
  /** The superfan pass in flight. */
  protected superfanRun: Promise<void> = Promise.resolve();
  private superfanBusy = false;
  private machineSuperfan: Lock | null = null;

  /** Start a superfan pass (the instance's, then the machine's if this coordinator holds it); each is skipped until due. */
  async checkSuperfan(): Promise<void> {
    const cfg = this.d.intake?.config() ?? null;
    const sf = cfg?.superfan;
    if (!this.d.superfan || !cfg || !sf?.enabled || !sf.channel || !cfg.discord.enabled || !this.chatSource()) return this.superfanStop();
    if (this.superfanBusy || this.halt.signal.aborted || this.stopped || this.usagePause() || this.diskHeld()) return;
    this.superfanBusy = true;
    this.superfanRun = (async () => {
      await superfanPass(this.superfanDeps(cfg, 'instance', sf.channel!));
      if (!sf.machine_channel) this.superfanStop();
      else if (this.takeMachineSuperfan()) await superfanPass(this.superfanDeps(cfg, 'machine', sf.machine_channel));
    })()
      .catch((e: Error) => void this.emit('coordinator.error', { instance: this.d.instance, where: 'superfan', kind: 'error', message: e.message.slice(0, 500) }))
      .finally(() => {
        this.superfanBusy = false;
      });
  }

  private get superfanSlots() {
    return this.d.slotsDir ?? slotsDir();
  }

  /** The machine's superfan: taken if free (or its holder died), kept once held. */
  private takeMachineSuperfan(): boolean {
    if (this.stopped) return false;
    if (this.machineSuperfan) return true;
    const r = tryLock(join(this.superfanSlots, MACHINE_LOCK), `superfan ${this.d.superfan!.name} ${process.pid}`);
    if (!('lock' in r)) return false;
    this.machineSuperfan = r.lock;
    return true;
  }

  /** Step down from the machine's superfan (shutting down, or its config is gone): another coordinator takes over. */
  protected superfanStop() {
    this.machineSuperfan?.release();
    this.machineSuperfan = null;
  }

  private superfanDeps(cfg: IntakeConfig, scope: 'instance' | 'machine', channel: string): SuperfanDeps {
    const name = this.d.superfan!.name;
    const dir = this.superfanSlots;
    const redact = (s: string) => scrub(redactPii(s, { names: cfg.redact.names, patterns: cfg.redact.patterns }));
    const routed = runRoute(this.d.cfg, 'intake_summary');
    const model = cfg.superfan.model ?? routed.model;
    const route = cfg.superfan.model ? { kind: 'other' as const, fallback: cfg.superfan.model } : routed.route;
    mkdirSync(this.d.stateDir, { recursive: true });
    return {
      scope,
      watching: scope === 'instance' ? `instance ${name}` : "the machine's engine and updater",
      stateFile: scope === 'instance' ? join(this.d.stateDir, 'superfan.json') : join(dir, MACHINE_STATE),
      stateMode: scope === 'instance' ? 0o600 : 0o660,
      settings: cfg.superfan,
      read:
        scope === 'instance'
          ? async () => {
              const events = this.d.log.read();
              return { events, incidents: readIncidents(dir).incidents.filter((x) => x.instance === name), health: healthView(events, null, { updates: [] }).suggestions, journal: (await this.d.superfan?.journal?.()) ?? null };
            }
          : () => ({ incidents: readIncidents(dir).incidents.filter((x) => x.instance === null), updates: updateLog() }),
      judge: async (prompt, maxUsd) => {
        const cwd = threadRunDir(dirname(this.d.repo), this.d.agentTasks?.gid ?? statSync(this.d.repo).gid, `superfan-${scope}`);
        // No tools, an empty directory, no environment of its own: the digest in the prompt is all it sees.
        const run = await this.d.runner.run({ role: SUPERFAN_ROLE, lane: RESEARCH_LANE, cwd, allowedTools: [], disallowedTools: [...REPLIER_DENIED], appendSystemPrompt: SUPERFAN_SYSTEM, prompt, jsonSchema: VERDICT_SCHEMA, maxTurns: 2, stateDir: this.d.stateDir, model, route, maxBudgetUsd: maxUsd, stallMs: 2 * 60_000, timeoutMs: 5 * 60_000 });
        this.cost(null, SUPERFAN_ROLE, run);
        return { ok: run.reason === 'succeeded', costUsd: run.costUsd, structured: run.structured, detail: run.detail };
      },
      post: async (key, text) => {
        const src = this.chatSource();
        if (!src) return false;
        await this.channelSend(src, key, { channel }, { kind: 'notice', text });
        return this.d.log.read(0, ['discord.posted']).some((e) => (e.payload as EventPayload<'discord.posted'>).key === key && (e.payload as EventPayload<'discord.posted'>).ok);
      },
      // The machine's superfan watches the engine, not this instance's repo: it only posts.
      ...(scope === 'instance' ? { file: (title: string, body: string, labels: string[]) => this.d.backlog.createIssue(title, body, labels) } : {}),
      redact,
      budgetLeft: () => this.d.cfg.agents.daily_budget_usd - this.spentToday(),
      now: () => this.d.now?.() ?? new Date(),
      record: (r) => void this.emit('superfan.pass', r),
    };
  }
}
