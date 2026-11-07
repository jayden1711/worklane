### Guardrail changes: what each one does

- **Planners and the plan reviewer read decision records as committed, in their brief (#970):** the decisions
  index already read each record at the plan's base (#920), but planner and plan-reviewer runs were told to read
  the record files in their checkout, where setup steps have run. Their briefs now carry each record's committed
  text (up to 60,000 characters in all; a record past that is named as not included), and their instructions say
  to read a record there, never its file in the checkout. docs/process.md drops this route from its open routes.
