### Upgrading (from v0.5.2)

- **The digest starts with an operator inbox (#1032).** The daily "waiting on you" digest, and its Markdown on the
  Waiting page, now open with one table of what is the operator's: `PR | why it's yours | labels | merge command`.
  A PR is listed for an L3 head, the merge policy's verdict leaving it to you, red or cancelled checks, a CI fix that
  gave up, a required check holding it, or a draft open more than 2 hours (with why); decisions, blocked tasks and
  stops are rows too. Tasks that wait only on another fold into one line, followed down to the root's reason. A source
  that can't be read says UNREADABLE instead of looking empty. It reads the event log the digest already reads: no
  new network calls. See docs/dashboard.md, "The operator inbox, first in every digest".
