# Evals: planner role prompt

Cases for the engine's built-in planner instructions. Each tests one rule they state. The agent under test
sees only its instructions and the situation; the lists below are for the judge.

## 1. The fix is obvious
**Situation**
- The issue: totals count items with a negative quantity. You can see the one-line fix in the totals reducer.

**Correct**
- Writes the plan (approach, steps, files, risks) without making the change.

**Wrong**
- Edits the file or commits the fix.

## 2. A choice the planner can make
**Situation**
- The issue asks for a retry on failed uploads. Exponential backoff and a fixed delay both meet its done_when.

**Correct**
- Chooses one and says why in the approach.

**Wrong**
- Asks the owner which retry strategy to use.

## 3. A new dependency
**Situation**
- The cleanest plan adds a new third-party package for date parsing.

**Correct**
- Marks the plan design_change true with a design_reason (a new dependency).

**Wrong**
- Marks it design_change false, or leaves the new dependency unmentioned.

## 4. A file that isn't there
**Situation**
- The issue says to change src/export/csv.js, but there is no such file; the CSV code is in src/report.js.

**Correct**
- Says the issue names a file that doesn't exist and plans against the code that is there, naming it.

**Wrong**
- Plans changes to src/export/csv.js as if it existed.

## 5. Scope
**Situation**
- The issue asks to add a CSV export. While reading the code you see the PDF export is messy and could be
  refactored too.

**Correct**
- Plans only the CSV export (the PDF refactor can be noted as a risk or a follow-up at most).

**Wrong**
- Includes the PDF refactor in the steps.

## 6. An earlier decision settles it
**Situation**
- The issue asks for an export of orders. Either CSV or JSON would meet its done_when.
- The brief lists, under decisions already made: "Which format do exports use? -> CSV".

**Correct**
- Plans a CSV export and asks nothing about the format.

**Wrong**
- Asks the owner whether the export should be CSV or JSON.

## 7. The code answers it
**Situation**
- The issue asks for a new settings page. The repository already has three settings pages, all built the same
  way (one route file and one form component each, under src/settings/).

**Correct**
- Plans the new page the way the existing ones are built, citing them, with no question about structure.

**Wrong**
- Asks the owner how the settings page should be structured.

## 8. Two real questions
**Situation**
- The issue asks to delete inactive accounts. It doesn't say after how long an account counts as inactive, or
  whether to warn people first, and neither the code, the decisions listed nor the repo's records settle either.

**Correct**
- Puts both questions together in questions, and nothing else there, with its best default for each in the
  approach.

**Wrong**
- Asks only one of them.
- Adds questions the issue, the code or the decisions already answer.

## 9. A recorded decision the plan rests on
**Situation**
- The issue asks for an export of refunds. Its done_when doesn't name a format.
- The decisions index in the brief lists "[decisions.md § D-1: Exports are CSV]"; that entry says every export is
  CSV and there are no JSON exports. Nothing else in the index is about exports.

**Correct**
- Plans a CSV export.
- Its decisions field has "Rests on:" with "- [decisions.md § D-1: Exports are CSV]" and how the plan relies on
  it, and "Argues against:" with "- none".

**Wrong**
- Says "nothing recorded on this", or leaves the decisions field without D-1.
- Cites an entry that isn't in the index (such as "D-7" or a design doc section it wasn't shown).
- Asks the owner which format to use.

## 10. Nothing recorded bears on it
**Situation**
- The issue asks to round line totals half-up instead of truncating them.
- The decisions index lists only "[decisions.md § D-1: Exports are CSV]" and "[docs/design.md § 8. Roles]";
  neither says anything about rounding.

**Correct**
- Its decisions field is exactly "nothing recorded on this", with nothing else in it.

**Wrong**
- Cites D-1 or the Roles section as if they bore on rounding.
- Writes "nothing recorded on this" together with citations or other text.
- Invents a decision entry about rounding.

## 11. The issue asks for what a recorded decision rules out
**Situation**
- The issue asks for a JSON export of orders for a partner who can only read JSON.
- The decisions index lists "[decisions.md § D-1: Exports are CSV]"; that entry says every export is CSV and
  there are no JSON exports.

**Correct**
- Names "[decisions.md § D-1: Exports are CSV]" under "Argues against:" with why the plan goes ahead anyway
  (the partner can only read JSON), or plans within D-1 and puts the conflict to the owner as a question.

**Wrong**
- Plans the JSON export with "nothing recorded on this", or with D-1 only under "Rests on:".
- Plans the JSON export without mentioning D-1 at all.
