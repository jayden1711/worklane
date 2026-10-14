// `intake check`: validate an instance's intake.yaml without waiting for the coordinator to read it. The same
// loader the coordinator uses (loadIntakeConfig), so "valid" here means intake stays on at the next pass, and each
// error here is the one that would turn it off. Read-only: nothing is written, and nothing is printed from the file
// but which sources are on, how many channels, the superfan's channel id, and the schema's own messages.
import { accessSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { instancesDir, listInstances } from '../instance.js';
import { INTAKE_FILE, loadIntakeConfig } from './config.js';
import type { IntakeConfig } from './report.js';

export type IntakeCheck =
  | { state: 'off'; file: string }
  | { state: 'invalid'; file: string; errors: string[] }
  | { state: 'valid'; file: string; summary: string[]; warnings: string[] };

/** What is on, in three lines. INVARIANT: only these fields of the file are ever printed (no ids of people). */
export function intakeSummary(c: IntakeConfig): string[] {
  const n = c.discord.channels.length;
  return [
    `discord: ${c.discord.enabled ? `on, ${n} channel${n === 1 ? '' : 's'}` : 'off'}`,
    `superfan: ${c.superfan.enabled ? `on, channel ${c.superfan.channel}` : 'off'}`,
    `github: ${c.github.enabled ? 'on' : 'off'}`,
  ];
}

/** Check one intake.yaml. Never throws: a file that can't be read is invalid, with why. */
export function checkIntakeFile(file: string): IntakeCheck {
  try {
    // WHY before the loader: it reports a file it can't open as bad YAML, and one it can't see as absent.
    accessSync(file, constants.R_OK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'off', file };
    // WHY: a file this user can't reach is not "absent, so off": the coordinator's own user may read it fine.
    return { state: 'invalid', file, errors: [`can't be read from this user (${code ?? 'error'}); run this as the instance's user`] };
  }
  try {
    const r = loadIntakeConfig(file);
    if (!r) return { state: 'off', file };
    if ('error' in r) return { state: 'invalid', file, errors: r.errors };
    return { state: 'valid', file, summary: intakeSummary(r.config), warnings: r.warnings };
  } catch (e) {
    return { state: 'invalid', file, errors: [`can't be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message.split('\n')[0]}); run this as the instance's user`] };
  }
}

export interface CheckCommandOptions {
  instance?: string | undefined;
  dir?: string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** The CLI command: pick the instance (as `discord channels` does), check its intake.yaml. Exit 0 valid or off, 1 invalid. */
export function intakeCheckCommand(o: CheckCommandOptions = {}): number {
  const out = o.out ?? ((l: string) => console.log(l));
  const err = o.err ?? ((l: string) => console.error(l));
  const dir = o.dir ?? instancesDir();
  let name = o.instance;
  if (!name) {
    const all = listInstances(dir);
    if (all.length !== 1) {
      err(all.length ? `more than one instance here (${all.join(', ')}); pass --instance <name>` : `no instance here (${dir}); run this as the instance's user, or pass --instance <name>`);
      return 1;
    }
    name = all[0]!;
  } else if (!existsSync(join(dir, name, 'instance.yaml'))) {
    // WHY: a mistyped name must not read as "no intake.yaml: intake is off".
    err(`no instance ${name} here (${dir}); run this as the instance's user`);
    return 1;
  }
  const c = checkIntakeFile(join(dir, name, INTAKE_FILE));
  if (c.state === 'off') {
    out(`no ${c.file}: intake is off`);
    return 0;
  }
  if (c.state === 'invalid') {
    err(`${c.file}: invalid; intake is off until it is fixed`);
    for (const e of c.errors) err(`  ${e}`);
    return 1;
  }
  out(`${c.file}: valid`);
  for (const l of c.summary) out(l);
  for (const w of c.warnings) out(`warning: ${w}`);
  return 0;
}
