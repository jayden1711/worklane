# "Hey Siri, tell / ask": Siri Shortcuts

Two Shortcuts on your phone reach the hub over your tailnet:

- **"Hey Siri, Tell Worklane"**: Siri asks "What should I tell it?", and what you say becomes an idea in the Inbox,
  waiting for an owner's or a writer's approval, exactly like a spoken idea on the dashboard. Siri says "Got it. It's
  in the Inbox for review."
- **"Hey Siri, Ask Worklane"**: Siri asks "What do you want to ask?", and reads back a short answer about the project,
  from what a **viewer** of the instance may see: open issues and pull requests, decisions waiting and recent activity.
  It never reads or speaks the repository's contents, runs, costs, spend, machine health, intake reports, the chat or
  the audit log.

That is all a Siri device token can do. It can't approve, merge, decide, change a setting, stop a run or reach any
other route, and it is never the dashboard key.

It replaces the dashboard's wake word (docs/wake-word.md), which ships no model.

## How it works

```
iPhone (Tailscale on) ──https://<machine>.<tailnet>.ts.net:8443──▶ tailscale serve
   ──▶ 127.0.0.1:4397  the hub's Siri gateway (wl-dash): POST /tell, POST /ask, GET /ask/<id>, nothing else
         ├─ from the tailnet only: the connection is tailscaled's (the kernel says so), and tailscale whois names the device
         ├─ the token's shape, and ten bad tokens from one device lock it out for 15 minutes
         └─ 127.0.0.1:<instance port>/api/siri/{tell,ask}  with the instance's Siri gateway token (never its dashboard token)
               the instance's dashboard (wl-<name>): the device token, its binding, the limits, the audit
               tell: the voice inbox, then the coordinator's intake (never trusted: an Inbox approval)
               ask:  a question file, then the coordinator's tool-less answer (research lane, no repository)
```

- **The gateway is its own listener.** It serves exactly three requests and shares nothing with the hub's sign-in
  port (no session, cookie, page or forwarding). `tailscale serve` publishes it on its own port, 8443, so the tailnet
  policy can let only your phone reach it.
- **From the tailnet only.** Behind `tailscale serve` every connection arrives from 127.0.0.1, so the address says
  nothing. The gateway counts a request only when the kernel says tailscaled opened the connection (a program on the
  machine connecting itself is refused whatever headers it sends), takes the one Tailscale address in serve's
  `X-Forwarded-For`, and asks `tailscale whois` which node it is: the same check as the owner terminal
  (src/console/terminal-devices.ts). The `Tailscale-User-*` headers are never read: they name a person, not a
  device, and aren't set for tagged devices ([Tailscale Serve](https://tailscale.com/kb/1312/serve)).
- **The gateway token works on the Siri routes only.** Each instance's dashboard writes `siri-gateway-token` beside
  its `dashboard-token`. It is accepted on `/api/siri/tell`, `/api/siri/ask` and `/api/siri/ask/<id>`, and nowhere
  else; the dashboard key is refused there. The hub reads only this file for Siri (with `--siri`), so nothing in the
  gateway can act as the owner.
- **Answers are short.** At most 400 characters (about 25 seconds aloud), cut at a sentence; markdown, links, ids
  and paths are removed in code. Each request answers within 8 seconds; the Ask Shortcut asks again by its id up
  to 6 times, so an answer has about a minute. Then Siri says "That's taking too long. Try again in a minute."

## Turning it on

Each step is off until you take it.

1. **The hub's gateway** (root, on the machine; review the script first):

   ```bash
   sudo bash scripts/setup/dashboards.sh --siri [your usual options] <name> [<name>...]
   sudo bash scripts/setup/tailscale.sh serve-siri
   ```

   `--siri` starts the gateway on 127.0.0.1:4397 and lets `wl-dash` read each instance's `siri-gateway-token`
   (without it, that read is removed). `serve-siri` runs `tailscale serve --bg --https=8443 http://127.0.0.1:4397`,
   beside the hub's 443, never Funnel.

2. **Your tailnet policy.** Let only your phone reach 8443, for example with a tag only you can assign:

   ```json
   { "action": "accept", "src": ["tag:owner-phone"], "dst": ["<machine>:8443"] }
   ```

3. **The instance.** In its `intake.yaml` (the instance home, 0600):

   ```yaml
   siri:
     enabled: true
     ask_model: haiku          # default
     ask_max_usd_per_day: 1    # default; at most 20. Every answer also counts against the daily budget.
   ```

4. **A token for your phone.** On the dashboard, Settings, **Siri devices**: name the phone and press **New token**.
   Only an owner can, from one of the console's allowed devices (`--console-devices`) or the break-glass, because a
   token is a credential. It is shown once: copy it to the phone now. The server keeps only its SHA-256.

5. **The Shortcuts** (below), with the token and the address `https://<machine>.<tailnet>.ts.net:8443`.

## The token

- It reads `worklane_siri_<instance>_<id>_<secret>`: the instance it works on, a 10-character id (shown on the
  dashboard and in the audit) and 256 random bits.
- **Bound on first use.** The first Tailscale device that uses it is the only one it works from after that. A use
  from another device is refused, audited, and shown on Settings ("refused from another device"). **Unbind** lets
  the next device bind it again (an owner, from an allowed device).
- **Revoke** cuts a device off from the next request. An owner can revoke from any browser, so a lost phone is cut
  off from wherever you are.
- **Expiry:** a token unused for 60 days stops working; make a new one. There is no fixed lifetime.
- **Limits**, per device: 20 tells and 10 asks an hour. Asks also stop at the day's Siri cap and at the instance's
  daily budget.
- Turning `siri.enabled` off turns every token off at once.

## The Shortcuts

The repository has their unsigned sources, `shortcuts/tell.shortcut` and `shortcuts/ask.shortcut`, written by
`node scripts/siri-shortcuts.mjs` (a test checks they match it, and that they hold no address, token, name or
contact). iOS imports only signed Shortcuts, and signing needs a Mac and Apple: "When you sign a shortcut, Apple
receives a copy for validation" ([shortcuts sign](https://support.apple.com/guide/shortcuts-mac/apd455c82f02/mac)).

**Signing (the owner, once on a Mac, and again only when a Shortcut changes):**

```bash
shortcuts sign --mode anyone --input shortcuts/tell.shortcut --output "Tell Worklane.shortcut"
shortcuts sign --mode anyone --input shortcuts/ask.shortcut --output "Ask Worklane.shortcut"
```

The file's name is the Shortcut's name, and the name is what you say to Siri. Use `--mode anyone`, never
`people-who-know-me`, which puts your contact details in the file. If `shortcuts sign` refuses the XML file, convert it
first (`plutil -convert binary1 shortcuts/tell.shortcut`). Share the signed files with your own devices (AirDrop,
Files); don't commit them.

**Adding one:** open the signed file on the phone. It asks two questions: the device token, and the hub's Siri
address. Apple: with an import question, "that field is cleared when the shortcut is shared", and the recipient
answers it ([import questions](https://support.apple.com/guide/shortcuts/apdf330fd3a0/ios)). The token lives only in
the Shortcut on your phone.

**By hand instead** (no Mac): in the Shortcuts app, make a Shortcut named "Tell Worklane" with these actions:

1. **Text**: the device token.
2. **Text**: `https://<machine>.<tailnet>.ts.net:8443`.
3. **Ask for Input** (Text): "What should I tell it?"
4. **Get Contents of URL**: the second Text, then `/tell`; Method POST; Header `Authorization`: `Bearer ` and the first
   Text; Request Body JSON, key `text`: Provided Input.
5. **Get Dictionary Value**: `speech` in Contents of URL.
6. **Speak Text**: Dictionary Value.

"Ask Worklane" is the same with "What do you want to ask?" and `/ask`, then: **Set Variable** `answer` to Contents of
URL; **Get Dictionary Value** `id`; **Repeat** 6 times: **Get Contents of URL** (GET) the second Text, `/ask/` and the
id, with the same header, then **Set Variable** `answer` to it; after the Repeat, **Get Dictionary Value** `speech` in
`answer`, and **Speak Text**.

### Siri, the lock screen and HomePod

- Siri runs a Shortcut by its name ([Use Siri to run shortcuts](https://support.apple.com/guide/shortcuts/apd07c25bb38/ios)).
  It can't take what you say in the same breath ("tell Worklane the login page is slow"): Siri asks for it next.
- **Locked phone.** Apple: "When your device is locked and you run a shortcut that opens an app, Siri asks to unlock
  your device before continuing." These Shortcuts open no app, so with Settings, Siri, "Allow Siri When Locked" on,
  they run from a locked phone, hands-free. Anyone who can make your phone's Siri listen can then tell and ask (see
  below). Turn "Allow Siri When Locked" off if that matters more to you than hands-free.
- **HomePod.** With Personal Requests on, HomePod can "run Siri Shortcuts on your iPhone or iPad" and "might require
  authentication for some requests" ([HomePod voice recognition](https://support.apple.com/en-ae/108397)). The request
  then runs on the phone and goes out through its Tailscale connection. Whether HomePod runs a Personal Request for a
  voice it doesn't recognise isn't something Apple's page says. **We recommend turning Personal Requests off on
  HomePods in shared rooms.**
- Not confirmed with Apple's documentation: how long Siri waits for "Get Contents of URL" (the 8-second answers and
  the retries assume about ten seconds), and whether the import questions are asked when the Shortcut is added or on
  its first run.

## What the dashboard shows

- **Settings, Siri devices** (owners and writers; writers read-only): each device's name, state (active, revoked,
  expired), the Tailscale device it is bound to, when it was last used and from where, who made it, and a refusal
  from another device. Owners: New token, Revoke, Unbind.
- **The audit log** (Activity, owners): every Siri request that reaches an instance, accepted or refused
  (`siri.tell`, `siri.ask`, `siri.refused`, `siri.bound`) and every change (`siri.token_created`,
  `siri.token_revoked`, `siri.unbound`), with the device, its token id and its Tailscale node. Never the words said,
  the answer or the token. Refusals the gateway makes before any instance is asked (not from the tailnet, a malformed
  token, a lockout) go to the hub's `siri-audit.jsonl`.
- **The Inbox**: a told idea is an intake approval, "via voice", like a spoken idea on the dashboard.

## Who can do what through it

| Who | What they can do through Siri | What stops more |
|---|---|---|
| Someone with your **unlocked phone** | Tell and ask as you; read the token in the Shortcut | The token works only from your phone's Tailscale device; Revoke from any browser |
| Someone at your **locked phone** or a **HomePod** with Personal Requests | Tell (an Inbox idea that waits for approval) and hear viewer-level answers, up to 20 + 10 an hour and the Siri cap | Nothing else is reachable; "Allow Siri When Locked" off, Personal Requests off |
| Someone with a **leaked token** | Nothing from any other device: refused and flagged | Bound to your phone's node; the tailnet policy keeps 8443 to your phone |
| A program on the machine | Nothing: refused before its token is read | The kernel's word on who opened the connection |
| A hub viewer or writer | See the device list (writers) | Only owners make, revoke or unbind |
