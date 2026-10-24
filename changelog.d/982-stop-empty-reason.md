### Guardrail changes: what each one does

- Merge policy: any auto-merge stop file that is there now holds every merge, whatever its reason holds (#982).
  Before, a stop file whose reason was an empty string, or an empty list, read as no stop, so PRs auto-merged. The
  merge decision, the dashboard's auto-merge state and the watchdog now read the stop file in one place: an empty,
  blank, missing or non-string reason shows as "stopped (the stop file gives no reason)", and a file that can't be
  read or parsed, or a symlink to nothing, shows as unreadable. Both hold.
