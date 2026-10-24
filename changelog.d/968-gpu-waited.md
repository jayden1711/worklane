### Guardrail changes: what each one does

- **The test-run helper's GPU line counts only the wait for the lock (#968).** `waited <s> s` in `worklane-testrun: gpu <N> (...)` is now the time spent in `flock` alone, summed over the run's GPUs. Before, it also counted the lock files' setup (their owner, group and mode checks), so a slow machine could report a wait on a lock nobody held. The wait still counts against the run's timeout as before, and the unit still gets what is left.
