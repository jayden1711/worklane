### Guardrail changes: what each one does

- **The push limits refuse, never throw, when git fails while they read a range (#981):** a repo changed under them
  (a config broken between calls, a branch deleted) or a name that isn't a commit used to throw, which ended a landing
  tick. Now it is one refusal, "the push limits couldn't read the range", naming git's reason, and nothing is pushed.
- **The push limits read the range by commit id, and the push sends that commit (#981):** the range's ends are
  resolved once, so a branch moved or deleted while the limits run changes nothing they read, and a branch moved
  after the check no longer sends a commit the limits never saw.
