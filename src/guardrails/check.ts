// Rule-conflict check. Every rule set is run against its corpus of
// must-block / must-ask / must-allow examples before it can go live. A new
// rule that blocks something that must stay frictionless, or a block rule no
// example exercises, fails the check.
import { resolve } from 'node:path';
import type { Example, GuardrailsConfig } from '../config/schema.js';
import { evaluate, type Decision, type EvalContext, type ToolCall } from './engine.js';
import { fingerprint } from './fingerprint.js';

export interface CheckProblem {
  kind: 'expected_block' | 'expected_ask' | 'expected_allow' | 'untested_rule';
  example?: string;
  got?: Decision;
  rule?: string;
  message: string;
}

function describe(e: Example): string {
  if ('bash' in e) return `bash: ${e.bash}`;
  if ('tool' in e) return `${e.tool}: ${e.path}`;
  return `fetch: ${e.fetch}`;
}

function toCall(e: Example, root: string): ToolCall {
  if ('bash' in e) return { tool: 'Bash', input: { command: e.bash }, cwd: e.cwd ? resolve(root, e.cwd) : root };
  if ('tool' in e) return { tool: e.tool, input: { file_path: resolve(root, e.path) }, cwd: root };
  return { tool: 'WebFetch', input: { url: e.fetch }, cwd: root };
}

/** A context built only from the config's example fixtures: no real secrets, no real link files. */
export function exampleContext(cfg: GuardrailsConfig, root: string, agent: boolean): EvalContext {
  const sets: Record<string, Set<string>> = {};
  for (const name of Object.keys(cfg.fingerprints)) {
    sets[name] = new Set((cfg.examples.fingerprints[name] ?? []).map((u) => fingerprint(u) ?? ''));
  }
  const links = cfg.examples.linked_environments;
  return {
    projectRoot: root,
    agent,
    env: {},
    fingerprints: sets,
    linkedEnvironment(_resolver, cwd) {
      for (const [dir, env] of Object.entries(links)) if (resolve(root, dir) === resolve(cwd)) return env;
      return null;
    },
  };
}

export function checkGuardrails(cfg: GuardrailsConfig, root = '/project'): CheckProblem[] {
  const problems: CheckProblem[] = [];
  const firedBy = new Set<string>();
  const run = (e: Example) => {
    const v = evaluate(toCall(e, root), cfg, exampleContext(cfg, root, e.agent));
    if (v.rule) firedBy.add(v.rule);
    return v;
  };
  for (const e of cfg.examples.must_block) {
    const v = run(e);
    if (v.decision !== 'deny') problems.push({ kind: 'expected_block', example: describe(e), got: v.decision, message: `must be blocked but got ${v.decision}` });
  }
  for (const e of cfg.examples.must_ask) {
    const v = run(e);
    if (v.decision !== 'ask') problems.push({ kind: 'expected_ask', example: describe(e), got: v.decision, message: `must ask but got ${v.decision}` });
  }
  for (const e of cfg.examples.must_allow) {
    const v = run(e);
    if (v.decision !== 'none') {
      problems.push({ kind: 'expected_allow', example: describe(e), got: v.decision, ...(v.rule ? { rule: v.rule } : {}), message: `must stay frictionless but rule ${v.rule} returned ${v.decision}` });
    }
  }
  for (const r of cfg.rules) {
    if (!firedBy.has(r.id)) problems.push({ kind: 'untested_rule', rule: r.id, message: `no must_block/must_ask example exercises rule ${r.id}` });
  }
  return problems;
}
