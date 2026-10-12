// Stable targets in a page, as a browser check or the dashboard's control script names them:
// `testid:<data-testid>`, `text:<visible text>` (a button, link, tab or option showing it), or, for the
// dashboard's own checks only, a CSS selector. Each becomes a page expression for the element, or null.

/** A page expression evaluating to the target's element, or null. */
export function targetExpr(target: string): string {
  if (target.startsWith('testid:')) return `document.querySelector(${JSON.stringify(`[data-testid="${target.slice(7)}"]`)})`;
  if (target.startsWith('text:')) {
    const want = JSON.stringify(target.slice(5).trim());
    // The whole text, or its first line (buttons often carry a key hint on a line of their own).
    return `[...document.querySelectorAll('button,a,[role=button],[role=tab],[role=option],[role=menuitem]')].find((e) => { const t = e.innerText.trim(); return (t === ${want} || t.split('\\n')[0].trim() === ${want}) && e.offsetParent !== null; })`;
  }
  return `document.querySelector(${JSON.stringify(target)})`;
}
