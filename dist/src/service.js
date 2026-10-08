// The coordinator as a long-running process: one per project per machine
// (a pid lock), started by the OS service manager so it never depends on a
// Claude session. It recovers on start, ticks, and backs up the log hourly
// with verified read-back.
import { readFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { BRAND } from './brand.js';
import { FileBacklog } from './backlog/file.js';
import { GitHubBacklog } from './backlog/github.js';
import { loadConfig } from './config/load.js';
import { Coordinator } from './coordinator.js';
import { backup, dirStore } from './events/backup.js';
import { EventLog } from './events/log.js';
import { projectStateDir } from './guardrails/context.js';
import { tryLock } from './locks.js';
import { slotStatus } from './slots.js';
import { CliRunner } from './runner.js';
import { latestBaseline } from './baseline.js';
export const instanceId = () => `${userInfo().username}@${hostname().split('.')[0]}`;
export const logPath = (root) => join(projectStateDir(root), 'events.db');
export const serviceLabel = (cfg) => `dev.${BRAND.cli}.${cfg.project.project.name.replace(/[^A-Za-z0-9-]/g, '-')}`;
export function backlogFor(cfg, root) {
    return cfg.project.backlog === 'github' ? new GitHubBacklog(cfg.project.project.repo) : new FileBacklog(join(projectStateDir(root), 'backlog.json'));
}
export async function runCoordinator(root, opts = {}) {
    const cfg = loadConfig(root);
    const state = projectStateDir(root);
    const lock = tryLock(join(state, 'coordinator.lock'), `coordinator ${instanceId()}`);
    if (!('lock' in lock)) {
        console.error(`another coordinator is running for this project (pid ${lock.holder?.pid})`);
        return 1;
    }
    const log = new EventLog(logPath(root));
    const coordinator = new Coordinator({ cfg, log, backlog: backlogFor(cfg, root), runner: new CliRunner(cfg.project.agent_runtime.kind), repo: root, instance: instanceId(), stateDir: state });
    const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
    log.append('coordinator.started', { instance: instanceId(), pid: process.pid, version }, instanceId());
    const requeued = await coordinator.recover();
    if (requeued.length)
        console.log(`recovered: requeued ${requeued.map((n) => `#${n}`).join(', ')}`);
    let stopping = false;
    const stop = () => {
        stopping = true;
        coordinator.stop();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    const backupDir = opts.backupDir ?? process.env[`${BRAND.envPrefix}_BACKUP_DIR`] ?? join(state, 'backups');
    let lastBackup = 0;
    try {
        do {
            await coordinator.tick();
            if (Date.now() - lastBackup > 3600_000) {
                const b = await backup(log, dirStore(backupDir));
                if (!b.ok)
                    log.append('coordinator.error', { instance: instanceId(), where: 'backup', kind: 'backup_failed', message: b.error ?? 'unknown' }, instanceId());
                lastBackup = Date.now();
            }
            if (opts.once)
                break;
            await new Promise((r) => setTimeout(r, (opts.intervalMs ?? 60_000) + Math.random() * 5_000));
        } while (!stopping);
        await coordinator.idle();
    }
    finally {
        log.close();
        lock.lock.release();
    }
    return 0;
}
/** A plain-text status summary from the event log (the dashboard reads the same log). */
export function status(root) {
    const cfg = loadConfig(root);
    const log = new EventLog(logPath(root));
    try {
        const ev = log.read();
        const day = new Date().toISOString().slice(0, 10);
        const spent = ev.filter((e) => e.type === 'run.cost' && e.ts.startsWith(day)).reduce((s, e) => s + e.payload.usd, 0);
        const byIssue = new Map();
        for (const e of ev) {
            const n = e.payload.issue;
            if (typeof n === 'number')
                byIssue.set(n, e.type);
        }
        const open = [...byIssue].filter(([, t]) => !['issue.released', 'deploy.verified'].includes(t));
        const decisions = ev.filter((e) => e.type === 'decision.asked').filter((q) => !ev.some((a) => a.type === 'decision.answered' && a.payload.id === q.payload.id));
        const slots = slotStatus();
        const started = ev.filter((e) => e.type === 'coordinator.started').at(-1);
        const lastTick = ev.filter((e) => e.type === 'coordinator.tick').at(-1);
        const base = latestBaseline(log);
        const baseLine = base
            ? `main baseline: ${base.failing.length} failing at ${base.sha.slice(0, 8)} (recorded ${base.recordedAt})${base.failing.length ? `: ${base.failing.slice(0, 8).join(', ')}${base.failing.length > 8 ? ', ...' : ''}` : ''}`
            : `main baseline: none recorded (landing blocks on any red until \`${BRAND.cli} baseline record\`)`;
        return [
            `${BRAND.name}: ${cfg.project.project.name} (${cfg.project.project.repo}), land mode ${cfg.project.land_mode}`,
            `coordinator: ${started ? `started ${started.ts} by ${started.actor}` : 'never started'}; last tick ${lastTick?.ts ?? 'never'}`,
            `agents running on this machine: ${slots.agents.length} of ${slots.cap}`,
            `spend today: $${spent.toFixed(2)} of $${cfg.agents.daily_budget_usd}`,
            baseLine,
            `in progress: ${open.length ? open.map(([n, t]) => `#${n} (${t})`).join(', ') : 'none'}`,
            `decisions waiting: ${decisions.length ? decisions.map((d) => `${d.payload.id} for @${d.payload.owner}: ${d.payload.question}`).join('; ') : 'none'}`,
        ].join('\n');
    }
    finally {
        log.close();
    }
}
//# sourceMappingURL=service.js.map