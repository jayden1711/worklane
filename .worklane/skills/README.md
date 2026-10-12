# Skills

Project skills (`<name>/SKILL.md` plus `evals/`). Repeated wins from lessons are promoted here.

Every SKILL.md has these sections (headings, `##` or deeper), none empty:

- **When to use**: the situations it's for.
- **Inputs and access**: what it reads and what it needs to run.
- **Steps**: what to do, in order.
- **Validate**: how to check the result. A skill whose result can't be checked is a guess.
- **Return**: what to report, and where.
- **Approval**: what needs the owner first.

`worklane skill lint` checks every SKILL.md in the repo and exits 1 if one fails (add it to the project's CI).
`worklane doctor` reports it, and the harness refuses to push a change that leaves a failing SKILL.md.
