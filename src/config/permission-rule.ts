import { z } from 'zod';

/**
 * A Claude Code permission rule, as `pre_approved` lists them: a tool's name (`Read`, `mcp__srv__tool`), and its
 * specifier in parentheses (`Bash(npm test:*)`). Never anything starting with `-` (R1185aa D1: an element `--setting-
 * sources=...` would be read as a flag in the agent's argv), and one line.
 */
export const PermissionRule = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*(?:\([^\n]*\))?$/, 'a permission rule: a tool name, and its specifier in parentheses (`Bash(npm test:*)`)');
