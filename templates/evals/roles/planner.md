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
