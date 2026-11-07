// The push-hook guard reads a runner's command after the runner's own options, so a value option the table lists
// wrongly hides the command (strace --silent git push). Each runner installed here is checked against its own
// option parser, given only the option: with no command it runs nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { RUNNERS } from '../src/guardrails/push-hook.js';

const dirs = [...(process.env.PATH ?? '').split(delimiter), '/usr/sbin', '/sbin'].filter(Boolean);
const installed = (name: string) => dirs.map((d) => join(d, name)).find((p) => existsSync(p));
const cwd = mkdtempSync(join(tmpdir(), 'runner-options-'));
/** What `bin args` prints, with stdin closed and a default shell (unshare, nsenter, fakeroot run one) of false. */
function output(bin: string, args: string[]): string {
  const r = spawnSync(bin, args, { cwd, input: '', encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', SHELL: '/bin/false' } });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`;
}
const valueWords = (name: string) => [...[...RUNNERS[name]!.value.short].map((c) => `-${c}`), ...RUNNERS[name]!.value.long.map((l) => `--${l}`)];
const sorted = (s: string) => [...s].sort().join('');
/** Letters a getopt string gives a required value (`x:`, not the optional `x::`). */
const requiredLetters = (optstring: string) => sorted([...optstring.matchAll(/([A-Za-z0-9])(?=:(?!:))/g)].map((m) => m[1]!).join(''));
/** Whether the program file holds a getopt string whose required-value letters are exactly `letters`. */
function getoptStringIn(bin: string, letters: string): boolean {
  const candidates = readFileSync(bin, 'latin1').match(/\+?[A-Za-z0-9:?]{6,}/g) ?? [];
  return candidates.some((s) => s.includes(':') && requiredLetters(s) === sorted(letters));
}
/** getopt's own report for an option given as the last word with no value: only an option that requires one. */
function assertRequiresValue(name: string, bin: string, words: string[]): void {
  for (const w of words) assert.match(output(bin, [w]), /requires an argument/, `${name} ${w}: not a required-value option of the installed ${name}`);
}

/**
 * A runner read from its program file, not run: its getopt string, and each long option's line in the help text
 * compiled into it (`help`: that line's shape for a required value).
 */
function fromFile(name: string, help?: (long: string) => RegExp): (bin: string) => void {
  return (bin) => {
    const { short, long } = RUNNERS[name]!.value;
    assert.ok(getoptStringIn(bin, short), `${name}: no getopt string in ${bin} with required values ${short}`);
    const text = readFileSync(bin, 'latin1');
    for (const l of help ? long : []) {
      assert.match(text, help!(l), `${name} --${l}: no required value in its help text`);
      assert.doesNotMatch(text, new RegExp(`--${l}\\[=`), `${name} --${l}: an optional value in its help text`);
    }
  };
}

/** How each runner is checked where running it with an option alone is not harmless or not getopt's. */
const CHECKS: Record<string, (bin: string) => void> = {
  // Tests never run these (test/isolate.ts HOST_TOOL_NAMES): `--name=VALUE`, never `--name[=VALUE]`.
  'systemd-run': fromFile('systemd-run', (l) => new RegExp(`--${l}=`)),
  runuser: fromFile('runuser', (l) => new RegExp(`--${l} <`)),
  // With no command it starts an agent.
  'ssh-agent': fromFile('ssh-agent'),
  // Its own parser: a value option takes the next word, so an unknown option after it is not reported.
  'dbus-run-session': (bin) => {
    const probe = '--runner-options-probe';
    assert.match(output(bin, [probe]), /unknown/);
    for (const w of valueWords('dbus-run-session')) assert.doesNotMatch(output(bin, [w, probe]), /unknown/, `dbus-run-session ${w}: takes no value`);
  },
  // Some hosts forbid running a tracer outside CI: there only its getopt string is read.
  strace: (bin) => {
    fromFile('strace')(bin);
    if (process.env.GITHUB_ACTIONS === 'true') assertRequiresValue('strace', bin, RUNNERS.strace!.value.long.map((l) => `--${l}`));
  },
};

for (const name of Object.keys(RUNNERS)) {
  const bin = installed(name);
  test(`${name}: every option the guard reads as taking the next word takes one in the installed program (#993)`, { skip: bin ? false : `${name} is not installed` }, () => {
    const check = CHECKS[name];
    if (check) check(bin!);
    else assertRequiresValue(name, bin!, valueWords(name));
  });
}
