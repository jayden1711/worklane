// One fail-closed reader for GitHub Actions workflow files (#948). The `yaml` package can read a workflow otherwise
// than GitHub's reader: some characters end a line for other YAML readers but not for `yaml` (a lone CR, NEL, LS,
// PS), so text after one inside a comment is hidden here and live on GitHub; `%YAML 1.1` changes how numbers and
// merge keys read; tags, non-decimal numbers, a twice-defined anchor and a non-string key can each resolve otherwise.
// Every engine and CI code path that parses a workflow's text goes through readWorkflowText, and treats a file it is
// `unsure` of as one it can't read (test/workflow-read.test.ts enforces both). First written as #746's test helper
// (test/desktop-removed.test.ts), whose generic checks now live here.
//
// Plain on purpose: scripts/ci/self-hosted-guard.mjs imports this file directly, so it stays erasable type syntax
// with one import, `yaml`.
import { isNode, isPair, isScalar, parse, parseDocument, visit } from 'yaml';

/** A workflow file as `yaml` reads it, and why GitHub may read it otherwise (`unsure`, null when there's no reason). */
export type WorkflowRead = {
  /** The parsed value; undefined when the text doesn't parse (`unsure` then says so). */
  value: unknown;
  unsure: string | null;
};

/** The only characters a workflow may hold, past a BOM at offset 0: TAB, LF and printable ASCII. */
const ODD = /[^\t\n\x20-\x7e]/;

/** Whether `v` holds a YAML merge key (`<<`) anywhere as a parsed key (`yaml` keeps one as a plain key). */
function hasMergeKey(v: unknown, seen: Set<unknown> = new Set()): boolean {
  if (typeof v !== 'object' || v === null || seen.has(v)) return false;
  seen.add(v);
  if (!Array.isArray(v) && Object.hasOwn(v, '<<')) return true;
  return Object.values(v).some((x) => hasMergeKey(x, seen));
}

/**
 * Read one workflow file's text (or bytes) and say whether it may read otherwise on GitHub. Unsure, each failing closed:
 * - bytes that aren't UTF-8;
 * - any character other than TAB, LF and printable ASCII, past a BOM at offset 0: a closed set that takes in a NUL,
 *   a lone CR, NEL, LS and PS, a BOM elsewhere, and every other control or non-ASCII character;
 * - text that doesn't parse (a duplicate key included);
 * - any `%YAML` or `%TAG` directive;
 * - a merge key anywhere, in the syntax tree (`<<`, `"<<"`, `!!merge <<`) or the parsed value;
 * - an explicit tag on any node, and a number scalar not written in plain decimal (GitHub reads hex and octal as
 *   32-bit numbers, `yaml` doesn't);
 * - an anchor defined twice;
 * - a mapping key that isn't a string scalar (`true:` and `"true":` are one property in JS).
 * A file this is sure of may still be one its caller can't use (no `jobs`, a job that isn't a mapping): those are
 * the caller's own checks.
 */
export function readWorkflowText(input: string | Uint8Array): WorkflowRead {
  let text: string;
  if (typeof input === 'string') text = input;
  else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      return { value: undefined, unsure: 'not UTF-8' };
    }
  }
  const odd = ODD.test(text.startsWith('﻿') ? text.slice(1) : text);
  let value: unknown;
  try {
    value = parse(text);
  } catch {
    return { value: undefined, unsure: odd ? 'a character outside TAB, LF and printable ASCII' : "the file doesn't parse" };
  }
  const unsure = (why: string): WorkflowRead => ({ value, unsure: why });
  if (odd) return unsure('a character outside TAB, LF and printable ASCII');
  const doc = parseDocument(text);
  if (doc.errors.length) return unsure("the file doesn't parse");
  if (doc.directives?.yaml.explicit || JSON.stringify(doc.directives?.tags) !== JSON.stringify({ '!!': 'tag:yaml.org,2002:' })) return unsure('a %YAML or %TAG directive');
  let merge = false;
  let tagged = false;
  let number = false;
  let twice = false;
  let oddKey = false;
  const anchors = new Set<string>();
  visit(doc, (_, n) => {
    if (isPair(n)) {
      if (isScalar(n.key) && n.key.source === '<<') merge = true;
      if (!(isScalar(n.key) && typeof n.key.value === 'string')) oddKey = true;
    }
    if (!isNode(n)) return;
    if (n.anchor !== undefined) {
      if (anchors.has(n.anchor)) twice = true;
      anchors.add(n.anchor);
    }
    if (n.tag !== undefined) tagged = true;
    if (isScalar(n) && ['number', 'bigint'].includes(typeof n.value) && !/^-?(0|[1-9][0-9]*)$/.test(n.source ?? '')) number = true;
  });
  if (merge || hasMergeKey(value)) return unsure('a merge key');
  if (twice) return unsure('an anchor defined twice');
  if (tagged) return unsure('an explicit tag');
  if (number) return unsure('a number not in plain decimal');
  if (oddKey) return unsure('a mapping key that is not a string');
  return { value, unsure: null };
}
