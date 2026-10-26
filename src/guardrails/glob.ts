/**
 * Minimal glob → RegExp for repo-relative paths: **, *, ?, and trailing "/" meaning "everything under".
 * `**` matches any characters, a newline among them (the `s` flag): git reads a path with a newline as itself, so
 * `.claude/skills/a<newline>b/SKILL.md` is under `.claude/**` like any other (#683).
 * `?` matches one character, one outside the BMP (an emoji, two UTF-16 units) included, so `keys/?.pem` matches a
 * one-emoji name (#966). It still matches a single unit too, so a `??` that matched such a name before still does.
 */
export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '(?:[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]|[^/])';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 's');
}
