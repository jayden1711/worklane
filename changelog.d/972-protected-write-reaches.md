### Guardrail changes: what each one does

- Tool guard: protected-path checks now decide on the file a write really reaches, as well as on the name it is
  given, for every write tool and the shell writes the guard reads. A project's path rules and the git-hooks check
  judge writes the same way.
- Tool guard, new refusals for agents: a write whose target the guard can't resolve; a write to a file that has more
  than one hard link; a shell command that makes a link to harness config.
- Event redaction: secrets in object keys are redacted as well as secrets in values.
