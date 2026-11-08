### Guardrail changes: what each one does

- The engine repo's merge process now explicitly lists `harness-config` among the locked categories that require two independent reviews (#999). This documents the existing requirement for `.worklane/**`, `.claude/**` and `CLAUDE.md` changes; it adds no runtime guard.
