### Guardrail changes: what each one does

- **Code a PR moves without git pairing it no longer lets a test of the moved code merge the PR (#1014).** Before, a file renamed and re-indented or edited, a function split out into another file or moved within its file, or moved code re-wrapped, read as added code: a test that ran the moved code merged the PR even when its real change was untested.
  - The vacuity gate now also measures each file with every top-level statement the PR moved whole (a function, a class, a declaration, an `exports.x =`) measured against its source, from any app file at the base, a deleted one included. It pairs a statement first by its code, then by its declared name, the closest same-named pair first, so a same-named statement elsewhere never takes another's source. A file counts only where it counts both ways, so the pairing only ever takes measure away: a dead copy of an edited line's old text still never makes the edit count.
  - Only formatting is no change in a moved statement: whitespace, semicolons, a comma before a closing bracket, and parentheses in two positions:
    - around an arrow function's one parameter (`(u) =>`);
    - around one expression with no `,` or `;` of its own that doesn't start with `{`, opened right after an assignment's `=`, `=>`, `return`, `throw`, `(`, `[`, `,`, `?` (as in `??`) or `:`, and closed right before `;`, `,`, `)`, `]`, `}` or the end of the file.
    Every other parenthesis counts as code, so parentheses that change precedence count.
  - A statement git paired in place with its old text under the same name (edited where it was) pairs with no other statement: it is measured as git measured it, even when the PR removes a copy of its new text elsewhere.
  - A statement runs to its end, across a line its formatter wrapped. A line starting with `export` or `import` always starts a statement, and so does one starting with a keyword no expression goes on with (`const`, `let`, `var`, `enum`, `interface`, `declare`, `abstract`, `namespace`), whatever the line before ends with. A closing `}` that git keeps between a moved statement and the code written in its place doesn't stop the pairing.
  - Lines swapped inside a function that stays are not a move: reordering is a change, and a test that runs it counts as before.
  - **Limit:** these still read as added code, as before:
    - a statement renamed as it moved;
    - a statement moved inside one that stays (a method within its class, a statement into another function);
    - a statement re-wrapped with parentheses in any other position (`(a && b) || c`, `(x) ? y : z`, `? (y) :`, an IIFE written `}())`): those parentheses count as code;
    - a statement that keeps its name but is rewritten too far to align with its old text: in a large statement (150 lines) two replaced lines are enough;
    - in a file whose brackets the gate's lexer can't balance, every statement that doesn't start on an `export` or `import` line (an `exports.x =` in CommonJS, say).
