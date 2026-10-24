### Upgrading (from v0.5.2)

- **For an instance named `machine` or `console`, the way-out messages now read as a removal (#985).** Where another instance's message tells an admin to take its policy over again with `policy own <name> --retake`, these say the admin removes the instance with `instance-remove.sh` and adds it again under another name. Before, some of them put the removal command into a sentence that still described a takeover. The messages for every other name are unchanged.
