### Guardrail changes: what each one does

- Merge policy: each merge decision takes the default branch's tip once, at its start, and reads the money-path list
  at that commit, the same one its check for a removed or weakened test, lint or guard reads. A path the default
  branch added to the list since the clone's last fetch now holds the merge for the owner. When that fetch fails, the
  decision waits, as before. review.yaml itself still comes from the running config.
