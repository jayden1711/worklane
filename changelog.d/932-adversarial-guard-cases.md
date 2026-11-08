### Guardrail changes: what each one does

- **The adversarial suite now attacks the guards around the agents and around pushes (#707).** `test/adversarial/guards.test.ts` feeds hostile inputs to the tool guard, an agent run's settings and sandbox settings, the push guard, the push gate, the commit scan and redaction, each through its own entry point. It is a lint test (it carries the `// lint-test` mark), so a change that takes a line out of it waits for the owner.
- **"Covered" is a measurement now.** `test/adversarial/mutants.json` lists, per guarantee, the mutants that break it. A guarantee counts as covered only when it isn't open on main and the suite kills every one of its mutants. `node test/adversarial/run-mutants.mjs` re-runs the list after a build (docs/guardrails.md).
