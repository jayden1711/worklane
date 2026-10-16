# Automations

An automation is an agent task the instance runs for you, on a schedule or when something happens. It runs with
its own budget and the same sandbox, review and merge rules as any other run. Find it in the dashboard under
**Extend → Automations** (owners and writers).

## What one is

| Part | What it is |
|---|---|
| Trigger | a schedule (cron, this machine's local time), a GitHub event, `run <command>` to the Discord bot, or a signed webhook from your tailnet |
| Mode | **task**: files an issue with its `done_when` and `ready`; the normal build flow takes it (contract, sandbox, evaluator, review level, merge policy, never auto-merged at L3). **report**: one read-only run (Read, Glob, Grep: no shell, no edits, no web); its answer is posted as a comment on the triggering issue or PR, else on the automation's own log issue |
| Template | the issue's title and outcome (`{date}`, `{week}`, `{trigger.kind}`, `{trigger.ref}` are filled in), and for a task its `done_when` |
| Budget | at most `per_run_usd` a run and `per_day_usd` a local day; every run on a task's issue counts |
| Limits | `runs_per_day` (1–24) and `cooldown_minutes` |
| Chain | `accept_from`: the automations whose output may start this one (default none) |
| Owner | the owner who made it; it stops firing if they're no longer an admin of the repo |

## Where definitions live

In the instance, never in the repo: `<instance home>/automations.yaml` (0600, the coordinator user's). Only the
dashboard writes it, through Review → Confirm. An agent can open PRs to the repo, so a definition there would let it
schedule itself.

The instance policy (`policy.yaml`, owners only, the First run page's Policy form) turns automations on:

```yaml
automations:
  enabled: false          # off until an owner turns it on
  max_runs_per_day: 12    # all automations together, a local day
  max_concurrent: 1       # automation runs at once
  budget_share: 0.25      # of the daily budget, for all automations together
```

The repo's `config.yaml` can only tighten that: `automations: { enabled: false }` turns them off, and
`max_runs_per_day` or `daily_usd` lower the caps. A higher value there changes nothing.

## Who can do what

| | Owner | Writer | Viewer |
|---|---|---|---|
| See automations, their runs and spend | yes | yes | no |
| New, edit, delete, resume | yes | no | no |
| Pause, run now | yes | yes | no |
| Rotate a webhook's secret, unbind its device | yes | no | no |
| Approve a run that waits for approval | yes (dashboard only) | no | no |

## Triggers

- **Schedule.** Five fields (minute hour day month weekday), local time. The minute is one number, so a schedule
  fires at most once an hour. A time missed (the machine off, a hold) still fires within 2 hours, once; never later.
  A time inside the hour daylight saving skips fires once after the change; inside the hour it repeats, once.
- **GitHub.** `issue.opened`, `issue.labeled` (with the label), `issue_comment.created` (the comment starts with
  `/<command>`), `pull_request.opened`, `pull_request.merged`. Only a writer or owner of the repo starts one (their
  role read as the dashboard reads it). Polled, never a webhook: one poller per instance, three conditional
  listings every 5 minutes, only while an enabled automation listens to GitHub, and it holds off when under 10% of
  the hour's GitHub calls are left.
- **Discord.** `run <command>` addressed to the instance's bot in a channel it reads, from an allowed, mapped sender
  who is a writer or owner. Uses the intake's own connection; nothing new to set up.

- **Webhook.** A signed `POST` to the hub's hooks gateway, from your tailnet only. Every run it asks for waits for
  its owner's approval (below). See "Webhooks".

A trigger's text (an issue's body, a comment, a chat message) reaches the run only redacted, cut to 4,000
characters and fenced as untrusted data. Nothing in it chooses the automation, its mode, budget, labels or chain.

## Loops

- An automation never starts itself, and never one already in its chain.
- Its output (the issue it filed, the PR that issue's build opened, a comment it posted) starts another automation
  only if that one lists it in `chain.accept_from`, and never more than 2 deep.
- Chains are traced only through the event log, never through text on GitHub.
- Other bot activity, the harness's own included, never starts an automation.
- A trigger while a run of the same automation is still going is folded into it (refused as coalesced).
- Three failed runs in a row pause the automation; an owner resumes it.

## Budgets

Every run is capped at the least of: its per-run budget, what its day's budget has left, what all automations'
share has left today, and what the instance's daily budget has left. A task's builds stop before any attempt once
that is under $0.10. Days are this machine's local days.

## Approval before a run

An automation with "Ask me before each run" (`gates.start: approve`; always on for a webhook) never runs on its
trigger. Its owner gets an Inbox decision (approve / reject) that only an owner answers, and only on the dashboard:
never from Discord or voice. On approve, every cap and the owner are checked again, then it runs once. Unanswered for a
day, it expires and never runs. Another trigger while one waits is folded into it.

## Webhooks

Set up once, as root on the machine (both are opt-in):

```sh
sudo bash scripts/setup/dashboards.sh --hooks ... <instances>    # the hub's hooks gateway on 127.0.0.1:4396
sudo bash scripts/setup/tailscale.sh serve-hooks                 # https 8444 on this machine's tailnet name; never Funnel
```

Then an owner adds a webhook automation on Extend. After Confirm, its secret is shown once, with how to sign a
delivery:

```sh
ts=$(date +%s); id=$(uuidgen); body='{"text":"deployed v1.2"}'
sig=$(printf '%s.%s.%s' "$ts" "$id" "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
curl -X POST "https://<this machine's tailnet name>:8444/hook/<instance>/<id>" \
  -H "x-hook-timestamp: $ts" -H "x-hook-delivery: $id" -H "x-hook-signature: v1=$sig" --data "$body"
```

What is checked, and by whom:

- **The hub's gateway** takes a request only from the tailnet: a connection tailscaled made, and a node Tailscale
  names; never this machine's own node. Ten refused deliveries from one node in ten minutes lock it out for fifteen.
  It holds no secret, so it can't sign; it passes the delivery to the instance with its own token, which works on
  the instance's `/api/hooks/` route and nowhere else.
- **The instance** checks the rest: the automation exists, is on and takes webhooks; the timestamp is within 5
  minutes; the signature is HMAC-SHA256 with its own secret over `<timestamp>.<delivery>.<body>`; the delivery id was
  never seen; and the device is the one it is bound to (the first that sent a valid delivery; an owner can unbind it).
  Every refusal answers the same `401 {"error":"refused"}`. A body is at most 64 KiB; at most 30 deliveries an hour
  are taken; 50 refused in an hour pause the automation.
- An accepted delivery is only recorded, its body redacted and cut, as untrusted text. It becomes an approval decision.

Each secret is its own file in the instance's home (`automation-secrets/<id>`, 0400 in a 0700 folder), never in
automations.yaml, an event, the audit, or any answer after the one that shows it. **Rotate secret** makes a new one
and the old one stops at once.
