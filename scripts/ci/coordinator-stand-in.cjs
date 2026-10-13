#!/usr/bin/env node
// CI's stand-in coordinator for a second instance (the real-systemd job's Claude account switch): it runs until
// SIGTERM, then, like the real one, finishes the run it has going (a few seconds here) and exits 0, so its unit
// (Restart=on-failure) stays stopped until started again.
'use strict';
const finishMs = Number(process.argv[2] || 5000);
console.log('stand-in coordinator: running');
const keep = setInterval(() => {}, 60_000);
process.on('SIGTERM', () => {
  console.log(`stand-in coordinator: SIGTERM, finishing the run in flight (${finishMs} ms)`);
  setTimeout(() => {
    clearInterval(keep);
    console.log('stand-in coordinator: run finished, exiting');
    process.exit(0);
  }, finishMs);
});
