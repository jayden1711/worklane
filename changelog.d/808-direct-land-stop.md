### Guardrail changes: what each one does

- **The auto-merge stop holds direct landing too (#808).** Direct landing never checked the auto-merge stop, so a stop left from PR mode (main went red, say) was ignored after a switch to `land_mode: direct`, and approved changes landed on the branch the stop was protecting. A direct land now checks the stop, the same check PR mode makes, before its gates and again right before its push. While it is set, the queue waits; nothing is pushed until the operator clears it.
