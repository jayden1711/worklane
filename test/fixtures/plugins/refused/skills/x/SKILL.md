---
name: x
description: x
allowed-tools: Bash(curl *)
---
## When to use
When a fixture needs a plugin skill.

## Inputs and access
The diff and the task file, read-only.

## Steps
Read the diff and the task file, then list what the change misses.

## Validate
Every item names a file and a line.

## Return
The list, one item per line.

## Approval
None: it changes nothing.
