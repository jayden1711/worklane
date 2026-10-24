// The instance's intake config, intake.yaml in the instance home: which sources are on, who is trusted, what to
// redact. It decides who may file `ready` issues, so only its owner may change it: refused when its group or others
// can write it, or when it belongs to another user. Absent: intake is off.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { parse } from 'yaml';
import { IntakeConfig, intakeWarnings } from './report.js';

export const INTAKE_FILE = 'intake.yaml';

/**
 * Load and check intake.yaml. Refused (`error`): unsafe permissions, bad YAML, or an invalid config, including a
 * trusted sender who isn't an allowed one. `errors` is the same refusal one problem at a time, each schema error
 * as "<path>: <message>" (`intake check` prints them). `warnings`: valid but probably not meant (Discord on,
 * nobody allowed).
 */
/** A load error naming the file by its name, not its path under the instance home: the dashboard shows it (#882). */
export const intakeErrorByName = (path: string, error: string): string => (error.startsWith(`${path} `) ? `${basename(path)}${error.slice(path.length)}` : error);

export function loadIntakeConfig(path: string): { config: IntakeConfig; warnings: string[] } | { error: string; errors: string[] } | null {
  if (!existsSync(path)) return null;
  const refuse = (why: string) => ({ error: `${path} ${why}`, errors: [why] });
  // Where files have POSIX owners and modes (not Windows, which has neither getuid nor meaningful mode bits).
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null) {
    const st = statSync(path);
    if (st.mode & 0o022) return refuse('is writable by its group or others; it decides who is trusted, so only its owner may change it (chmod 600)');
    // It maps people's chat ids to their GitHub logins: nobody else on the machine reads it either.
    if (st.mode & 0o044) return refuse('is readable by its group or others; it names who is who, so only its owner may read it (chmod 600)');
    if (st.uid !== uid && st.uid !== 0) return refuse("belongs to another user; it must be this service's own file (or root's)");
  }
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return refuse(`is not valid YAML: ${(e as Error).message.split('\n')[0]}`);
  }
  const r = IntakeConfig.safeParse(raw);
  if (!r.success) {
    // WHY "(top level)": an unknown top-level key has an empty path, and a bare ": message" names nothing.
    const errors = r.error.issues.map((i) => `${i.path.join('.') || '(top level)'}: ${i.message}`);
    return { error: `${path} is invalid: ${errors.join('; ')}`, errors };
  }
  return { config: r.data, warnings: intakeWarnings(r.data) };
}
