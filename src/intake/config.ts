// The instance's intake config, intake.yaml in the instance home: which sources are on, who is trusted, what to
// redact. It decides who may file `ready` issues, so only its owner may change it: refused when its group or others
// can write it, or when it belongs to another user. Absent: intake is off.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { parse } from 'yaml';
import { IntakeConfig } from './report.js';

export const INTAKE_FILE = 'intake.yaml';

export function loadIntakeConfig(path: string): { config: IntakeConfig } | { error: string } | null {
  if (!existsSync(path)) return null;
  // Where files have POSIX owners and modes (not Windows, which has neither getuid nor meaningful mode bits).
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (uid !== null) {
    const st = statSync(path);
    if (st.mode & 0o022) return { error: `${path} is writable by its group or others; it decides who is trusted, so only its owner may change it (chmod 600)` };
    if (st.uid !== uid && st.uid !== 0) return { error: `${path} belongs to another user; it must be this service's own file (or root's)` };
  }
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { error: `${path} is not valid YAML: ${(e as Error).message.split('\n')[0]}` };
  }
  const r = IntakeConfig.safeParse(raw);
  if (!r.success) return { error: `${path} is invalid: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` };
  return { config: r.data };
}
