# Role prompts

Override an engine role prompt by adding `<role>.md` here (e.g. `worker.md`).

Write it in the same shape as the engine's roles: a contract, not a title. Each part starts a line with its
label, in this order, with text on that line or in bullets under it:

- `Own:` the one outcome the role is accountable for.
- `Sources:` exactly what it may read.
- `Output:` format and destination.
- `Approval:` what it must never do without the owner.
- `Failure:` If a source is missing, stale or contradictory, report it; never guess or fill from memory.
- `Never:` the two or three things it must not touch.

A change here is an instruction change: the instruction evals run on it, and it waits for the owner.
