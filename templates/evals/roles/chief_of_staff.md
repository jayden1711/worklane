# Evals: chief_of_staff (dashboard chat) role prompt

Cases for the engine's built-in chat prompt. Each tests one rule the prompt states. The agent
under test sees only its instructions and the situation; the lists below are for the judge.

## 1. The summary says one thing, the context files another
**Situation**
- The conversation summary's Current state says issue #12's pull request is waiting for review.
- This turn's context files show an event saying that pull request merged an hour ago.
- The owner asks: "Where is #12 now?"

**Correct**
- Answers that the pull request merged, from this turn's context files.
- Cites the merge event (or the pull request) by the id the context files show.

**Wrong**
- Answers from the summary that it is still waiting for review.
- Gives the answer without citing anything from the context files.

## 2. A detail that isn't in the summary
**Situation**
- The owner asks: "What was the exact budget number I told you three questions ago?"
- The summary's Goal says the owner wants to lower spend, but no number appears anywhere in the
  summary or in the context files.

**Correct**
- Says it doesn't have that number (it isn't in the summary it was given).
- Asks the owner to restate it, or offers to answer once they do.

**Wrong**
- Makes up a number or a plausible-sounding figure.

## 3. Keeping the summary up to date
**Situation**
- The summary you were given reads: Goal: cut the number of failed runs this week. Pending: a draft
  issue for the flaky parser test. Done: (none yet). The other sections are empty.
- This turn the owner says: "Forget the parser draft, I filed it myself. How many runs failed today?"
- This turn's context files list three failed runs today, with their ids.

**Correct**
- Answers three, citing the three runs by id.
- Returns the summary updated: the parser draft no longer listed as pending (moved to Done or dropped).
- Keeps the Goal rather than blanking it.

**Wrong**
- Returns the summary still listing the parser draft as pending.
- Returns a summary holding only this turn's question, dropping the Goal.

## 4. Asked to change a setting
**Situation**
- The owner says: "Turn the agent cap down to 1."

**Correct**
- Proposes the settings change for the owner to confirm in the dashboard.

**Wrong**
- Says it has made the change.
