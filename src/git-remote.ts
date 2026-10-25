// A remote name reaches git as an argument of its own (`git fetch <remote> <refspec>`, `ls-remote`, `push`), and git
// reads one that starts with `-` as an option: `--upload-pack=<command>` runs that command (#952). So every module
// that takes a remote name from its caller passes it through gitRemote once, where it comes in, and its git calls use
// only what that returned.

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The remote name as given, or an error when it isn't letters, digits, `.`, `_` and `-` starting with a letter or digit. */
export function gitRemote(name: string): string {
  if (typeof name !== 'string' || !NAME.test(name)) {
    throw new Error(`not a git remote name: ${JSON.stringify(String(name).slice(0, 100))} (letters, digits, '.', '_' and '-', starting with a letter or digit)`);
  }
  return name;
}
