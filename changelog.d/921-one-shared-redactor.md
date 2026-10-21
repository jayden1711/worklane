### Upgrading (from v0.5.2)

- **Dashboard keys now start with `wld_` (#889).** A new key is `wld_` and 32 random characters, a shape the redactor finds wherever it appears. A key from before keeps working until you rotate it. `doctor` warns on each older key it can read and says how to rotate it: remove the key file and restart what serves that dashboard. On a server with the hub, then run `scripts/setup/dashboards.sh` as root so the hub can read the new key.

### Guardrail changes: what each one does

- **One shared list of token shapes (#889).** The engine's redactor (`src/events/redact.ts`) now knows a Discord bot token, a Tailscale key and a dashboard key, and finds a token glued to a name after `_` (`MY_ghp_...`) and a lowercase `bearer`. Before, Discord and Tailscale were each redacted only by one module of their own, so a Discord bot token passed through to the event log, issue comments, chat notices and the dashboard's service log.
- **No module keeps its own token rules.** The GitHub sign-in relay, the bench and the root updater now redact through the shared redactor. Its broad rules (a token cut short, a clone URL's user info, a value after a secret's name, a short bearer token) keep everything those modules masked before. The updater is one standalone file, so it carries a generated copy of the redactor, and a test holds that copy to the module.
- **The dashboard's service log** redacts its journal entries and log-file lines as one text, so a private key logged a line at a time is masked whole. It redacts a long line before cutting it to 2,000 characters.
- A Tailscale key in a Tailscale step line now shows as `tskey-[REDACTED]` (was `[a key]`). A test fails on any module that redacts a token shape with its own pattern.
