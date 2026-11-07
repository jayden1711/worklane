### Guardrail changes: what each one does

- **The commit secret scan's tests now say when the guard blocks, and which refusal fired (#1010).**
  - The named-pipe test runs the hook in a child process that is killed after 30 s. If the guard ever read a large-file object that is a named pipe again, the test fails, naming the timeout, instead of blocking its CI shard.
  - The "begin like a pointer" test asserts the exact refusal, "looks like a large-file pointer but is not in its exact form", instead of any refusal.
  - Nothing changes for an install: only the tests changed.
