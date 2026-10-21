### Guardrail changes: what each one does

- **The adversarial suite now attacks the guards around the agents and around pushes (#707).** `test/adversarial/guards.test.ts` feeds hostile inputs to the tool guard, an agent run's settings and sandbox settings, the push guard, the push gate, the commit scan and redaction, each through its own entry point. It is a registered lint test, so a change that takes a line out of it waits for the owner.
