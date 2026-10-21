### Upgrading (from v0.5.2)

- **The agents' tool guard now refuses a tool call it hasn't decided within 10 s (#894).** Before, a guard that ran past its hook's 30 s timeout was cancelled by Claude Code, and the call went ahead unchecked. Ordinary calls take well under a second, so they aren't affected. The new holder runs as soon as the engine is updated, with no settings change. A checkout's own `.claude/settings.json` (local mode, no instance) gets Claude Code's `onFailure: "block"` on the guard's hook only when `install` runs again; an instance's agent runs get it with the update.

### Guardrail changes: what each one does

- **The tool guard's deadline (#894).** Every PreToolUse call is decided in a child process. The process Claude Code waits on holds a 10 s deadline and runs no guard code. It passes on an answer that lets the call through only when the guard ended by itself and wrote its verdict. A guard that is stuck, crashes, is killed, or ends without a verdict is refused: a deny, with exit code 2.
- **A deny reaches Claude Code whole (#894).** The guard's process exits only once its answer is written, or with exit 2 when it can't write it within 5 s. A deny's reason keeps at most 300 characters at each end of the word it quotes. Before, an agent could pad a path so that the deny passed the pipe's 64 KiB and arrived cut short, as invalid JSON with exit 0, which a Claude Code without onFailure "block" let through.
- **`onFailure: "block"` on the guard's hook (#894).** A PreToolUse guard hook that times out, can't start, exits with another code or prints invalid output now blocks the call (Claude Code 2.1.295 and later; the pinned CLI is 2.1.296). Every agent run's settings carry it, and install writes it.
