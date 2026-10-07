# Security policy

This project runs autonomous agents with access to source code, shells and credentials, so we treat security reports as the highest priority.

## Reporting a vulnerability

Report privately through [GitHub private vulnerability reporting](https://github.com/jayden1711/worklane/security/advisories/new). Do not open a public issue.

Include what you found, how to reproduce it, and the impact you expect. We aim to acknowledge reports within 3 business days and to agree a disclosure timeline with you.

## In scope

- Bypasses of guardrail hooks (blocked commands, protected files, the Stop gate)
- Ways for an agent to obtain GitHub write tokens or perform actions the coordinator didn't validate
- Secrets leaking into logs, transcripts, the event log or the dashboard
- Dashboard or relay authentication and authorization flaws
- Supply-chain issues in the install path

## Supported versions

Only the latest release receives fixes until 1.0.
