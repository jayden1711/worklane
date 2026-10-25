### Guardrail changes: what each one does

- **Code a PR moves without git pairing it no longer lets a test of the moved code merge the PR (#1014).** Before, a file renamed and re-indented or edited, a function split out into another file or moved within its file, or moved code re-wrapped, read as added code: a test that ran the moved code merged the PR even when its real change was untested.
  - The vacuity gate now also measures each file with every top-level statement the PR moved whole (a function, a class, a declaration, an `exports.x =`) measured against its source, from any app file at the base, a deleted one included. It pairs a statement first by its code (whitespace, parentheses, commas and semicolons left out), then by its declared name. A file counts only where it counts both ways, so the pairing only ever takes measure away: a dead copy of an edited line's old text still never makes the edit count.
  - A statement runs to its end, across a line its formatter wrapped. A closing `}` that git keeps between a moved statement and the code written in its place doesn't stop the pairing.
  - Lines swapped inside a function that stays are not a move: reordering is a change, and a test that runs it counts as before.
  - **Limit:** these still read as added code, as before:
    - a statement renamed as it moved;
    - a statement moved inside one that stays (a method within its class, a statement into another function);
    - a statement that keeps its name but is rewritten too far to align with its old text;
    - every statement in a file whose brackets the gate's lexer can't balance.
