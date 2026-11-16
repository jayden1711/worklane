#!/usr/bin/env node
// R1185y: the repo's wrap-second-turn-leak.cjs, gated on the run having a role prompt (--append-system-prompt-file): a console message delivered to a live worker (coordinator.ts:499) is such a turn.
// R1185r D2, a must-fail case for scripts/ci/setting-sources-probe.mjs: a wrapper around the real claude
// (SETTING_SOURCES_REAL_CLAUDE) that honours --setting-sources '' at a session's start, but from its second user turn
// on attaches the checkout's CLAUDE.md to each new turn, as a regression in claude's per-turn attachments might. The
// runner sends a second turn when it delivers a held message (src/runner.ts turnEnded); the probe's guarded run sends
// one, so it names this ("a guarded run's request carries projectClaudeMd").
const fs = require('node:fs'); const path = require('node:path'); const { spawn } = require('node:child_process');
const real = process.env.SETTING_SOURCES_REAL_CLAUDE; if (!real) { console.error('set SETTING_SOURCES_REAL_CLAUDE'); process.exit(2); }
const args = process.argv.slice(2); const i = args.indexOf('--setting-sources'); const guarded = i >= 0 && args[i + 1] === '';
const s = args.indexOf('--settings'); let settings = {}; try { settings = JSON.parse(args[s + 1]); } catch {}
const bare = args.includes("--append-system-prompt-file");
const child = spawn(real, args, { stdio: ['pipe', 'inherit', 'inherit'], env: process.env });
let buf = ''; let turns = 0;
process.stdin.on('data', (d) => {
  buf += d; let n;
  while ((n = buf.indexOf('\n')) >= 0) {
    let l = buf.slice(0, n); buf = buf.slice(n + 1);
    try { const j = JSON.parse(l); if (j.type === 'user' && ++turns > 1 && guarded && bare) { let md = ''; try { md = fs.readFileSync(path.join(process.cwd(), 'CLAUDE.md'), 'utf8'); } catch {} const c = j.message.content; j.message.content = typeof c === 'string' ? `${c}\n\n${md}` : [...c, { type: 'text', text: md }]; l = JSON.stringify(j); } } catch {}
    child.stdin.write(l + '\n');
  }
});
process.stdin.on('end', () => child.stdin.end());
child.on('exit', (c) => process.exit(c ?? 1));
