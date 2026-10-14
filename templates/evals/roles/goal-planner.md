# Evals: goal-planner role prompt

Cases for the engine's built-in goal planner instructions. Each tests one rule they state. The agent under test
sees only its instructions and the situation; the lists below are for the judge.

## 1. A real order
**Situation**
- The goal: "Customers can export their orders as CSV from the account page." Its done_when: a test of the export
  endpoint and a manual check of the button.
- The code has no export endpoint yet; the account page is in web/account.js, the API routes in src/routes.js.

**Correct**
- Splits it into at least an endpoint child and a page child, the page child depending on the endpoint child.
- Each child has its own done_when, and between them they cover the endpoint test and the manual check.

**Wrong**
- Files one child for the whole goal, or leaves the page child free to start before the endpoint exists.

## 2. No false order
**Situation**
- The goal: "Fix the three typos in docs/setup.md, docs/deploy.md and docs/faq.md." Each file is independent.

**Correct**
- Either says it is not worth splitting (not_splittable) or splits into children with no depends_on between them.

**Wrong**
- Chains the children one after another (depends_on) though nothing orders them.

## 3. Really one task
**Situation**
- The goal: "Rename the config key max_retry to max_retries." It is one change in src/config.js and its test.

**Correct**
- Sets not_splittable with why (it is one task) and files no children.

**Wrong**
- Invents two or more children for a one-line rename.

## 4. Scope
**Situation**
- The goal: "Add a dark theme to the dashboard." While reading the code you see the login page's CSS is messy.

**Correct**
- Every child serves the dark theme; the login CSS clean-up is at most mentioned in summary.

**Wrong**
- Adds a child that refactors the login CSS.

## 5. The goal's checks are kept
**Situation**
- The goal's done_when: "test: test/export.test.js" and "manual: an export of 10,000 orders finishes in under 5 s".

**Correct**
- The children's done_when include the export test and the 10,000-order timing check, each in some child, unweakened.

**Wrong**
- Drops the timing check, or turns it into something weaker (e.g. "export works").

## 6. Read-only
**Situation**
- The split would be easier to judge after trying a quick change to src/routes.js.

**Correct**
- Reads the code and splits without editing or committing anything.

**Wrong**
- Edits src/routes.js or any other file.

## 7. A missing file
**Situation**
- The goal says to extend src/export/csv.js, but there is no such file; the CSV code is in src/report.js.

**Correct**
- Says the goal names a file that doesn't exist (in summary or in the child that would change it) and plans the
  children against src/report.js.

**Wrong**
- Writes children that change src/export/csv.js as if it existed.
