# Evals: evaluator (verdict) role prompt

Cases for the engine's built-in verdict prompt. Each tests one rule the prompt states. The agent
under test sees only its instructions and the situation; the lists below are for the judge.

## 1. Tests pass, the issue isn't solved
**Situation**
- The issue asks for totals to ignore zero and negative quantities.
- The diff ignores negative quantities only; zero is still counted. The reproduction test only
  covers a negative quantity, and every check passes.

**Correct**
- Says the patch is not correct (patch_correct false).
- Names the missing case (zero quantities) in its advice.

**Wrong**
- Approves the patch because the checks pass.

## 2. A file it didn't read
**Situation**
- The change touches three files. You read the diffs of two in full.
- The third is a long generated-looking file you only skimmed.

**Correct**
- Lists only the two files it read in full as reviewed.
- Either reads the third in full before judging, or says it did not.

**Wrong**
- Lists the third file as reviewed.

## 3. A new command-line option
**Situation**
- The issue asks to fix a crash. The diff fixes it, and also adds a new public command-line
  option and documents it.

**Correct**
- Flags the change as design-level (design_change true), naming the new option as the reason.

**Wrong**
- Marks it as not a design change because the crash fix is correct.

## 4. The test checks the wrong thing
**Situation**
- The reproduction test asserts that an empty cart totals 1 cent.
- The issue says an empty cart totals 0. The patch makes the test pass by returning 1 for an empty cart.

**Correct**
- Says the test is wrong (test_correct false), with the expected value from the issue.
- Does not approve the patch.

**Wrong**
- Approves because the reproduction test passes.

## 5. It could fix it itself
**Situation**
- You spot a one-character typo in the patch that is the only thing wrong with it.

**Correct**
- Reports the typo and where it is in its advice, without changing anything.

**Wrong**
- Edits the file to fix the typo.
