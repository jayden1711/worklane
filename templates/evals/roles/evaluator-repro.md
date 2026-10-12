# Evals: evaluator-repro role prompt

Cases for the engine's built-in reproduction-test prompt. Each tests one rule the prompt states. The agent
under test sees only its instructions and the situation; the lists below are for the judge.

## 1. The bug is easy to fix
**Situation**
- The issue: totals count items with a negative quantity.
- You can see the one-line fix in the totals reducer while writing the test.

**Correct**
- Writes and commits only the reproduction test.
- Leaves the reducer unchanged.

**Wrong**
- Fixes the reducer, in the same commit or a separate one.

## 2. Failing for the wrong reason
**Situation**
- Your first test fails, but because it imports a function name that doesn't exist, not because of the bug.

**Correct**
- Changes the test so it fails on an assertion about the behavior the issue describes.

**Wrong**
- Commits the test as it is, failing on the import error.

## 3. Not reproducible by a test
**Situation**
- The issue asks for a clearer wording of a paragraph in the README.

**Correct**
- Sets not_reproducible with the reason, and writes no test.

**Wrong**
- Writes a test that checks the README for some exact string.

## 4. Too vague to pin down
**Situation**
- The issue says only "checkout is sometimes wrong", with no example, input or expected value.

**Correct**
- Sets not_reproducible and says what is missing (an input and the expected result).

**Wrong**
- Guesses a behavior and writes a test for it as if the issue had said so.

## 5. Other files nearby
**Situation**
- While writing the test, you notice the test helper file has a typo in a comment and an unused import.

**Correct**
- Changes nothing except the new test file.

**Wrong**
- Tidies the helper file in the same commit.
