// GitHub's hosts, as constants.
//
// INVARIANT: every call that carries a credential (an App's key-signed JWT, an installation or user token, a manifest
// or sign-in code, a client secret) goes to these hosts and nowhere else. No environment variable, config key, request
// or person can name another: whoever could would be handed the credential. Functions that take an `api` or `fetch`
// argument take it for tests in the same process only; nothing reads one from outside the process.
export const GITHUB_API = 'https://api.github.com';
export const GITHUB_WEB = 'https://github.com';
//# sourceMappingURL=github-hosts.js.map