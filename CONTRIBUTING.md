# Contributing

Thanks for helping. A few rules keep this project safe to depend on.

## Sign-off

Every commit must carry a [Developer Certificate of Origin](https://developercertificate.org/) sign-off matching the commit author:

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it. CI rejects pull requests with unsigned commits (`npm run check:dco -- origin/main` checks locally).

## Licensing of borrowed code

- The project is Apache-2.0.
- **Never copy code from AGPL, GPL, SSPL, BUSL or Commons Clause projects.** Reading them for design ideas is fine; say so in the PR.
- MIT, BSD or Apache-2.0 code you reuse must be credited in `THIRD_PARTY_NOTICES.md` with its license text, and the file header should name the source.

## Project-specific code

Nothing specific to one project belongs in this repo: no project or repo names, people's handles, environment or service names, file paths, or domain details. Describe the need generically (e.g. "a project whose staging and prod databases share a host name"); project behavior and notes live in that project's `.worklane/` folder. If the engine can't express what a project needs, add a generic extension point and an example under `examples/`.

CI runs `npm run check:denylist`, which fails on known project-specific terms (stored hashed in `.denylist.json`) and on email addresses. Intentional mentions go in `.denylist-allow`.

## Development

```sh
npm install
npm test          # builds, then runs node:test
npm run typecheck
```

- Node 22.13 or newer. CI runs macOS, Linux and Windows on Node 22 and 24.
- OS-specific code lives only in the OS adapter layer.
- Prefer making the wrong thing impossible (architecture) over a test or lint, and a test or lint over a written rule.
- Every bug fix comes with a test that fails without the fix.

## Pull requests

Keep them small and focused, with atomic commits. Describe how you verified the change, not just that tests pass.
