### After install

- **The machine helper's sudoers rules lose every `claude-account` command but `status` (#758): the `machine-helper.sh` rerun this release already needs for `set-policy` (#726), with every instance, does it** (`sudo bash /opt/worklane/current/scripts/setup/machine-helper.sh <every instance>`). It rewrites `/etc/sudoers.d/worklane-machine` whole, without `claude-account switch` and the six patterns for `claude-account profile-add`, `remove`, `use`, `login` and `failover … back|stay`. The updated helper already refuses all of them (#749, #736), so until the rerun those lines grant nothing; after it, the rules no longer list them. Nothing else in the rules changes, and nothing is added: `claude-account status` (the Machine page's Refresh) stays. The rerun's own check fails if a coordinator may still run any of them. `/etc/worklane/helper-rules.json` no longer lists `claude-account-profiles` among the rules an older sudo leaves out.

### Guardrail changes: what each one does

- **The machine helper's sudoers rules name only the claude-account command the helper runs (#758).** A coordinator user may run `claude-account status` through sudo, and no other claude-account command, on every sudo version. The helper refuses the others too, so neither layer alone has to hold.
