// The GitHub App's permissions, checked on a real installation token. The
// setup script runs this as the coordinator user (who alone can read the key),
// piped on stdin:
//   node --input-type=module - <key.pem> <app-id> <installation-id> <owner/repo> < app-permissions.mjs
// Imported by tests for the rules alone.

/** Needed for the coordinator to work at all. */
export const REQUIRED = {
  metadata: 'read',
  contents: 'write', // fetch, push task branches, lease refs
  issues: 'write', // the backlog
  pull_requests: 'write', // open PRs
  checks: 'read', // the PR watcher reads CI results
};

/** Not needed to start, but a feature can't work without it. */
export const EXPECTED = {
  actions: { level: 'read', why: 'CI fix runs read the failing job log with it' },
};

/** Never: each would let a change or a run get past the controls. */
export const REFUSED = {
  workflows: () => 'the App has the Workflows permission; remove it (a change to .github/workflows must not go out through the coordinator)',
  administration: () => 'the App has the Administration permission; remove it (it can change branch protection)',
  actions: (level) => (level === 'write' ? 'the App has Actions: write; set it to read (the harness never reruns or cancels jobs)' : null),
};

const rank = (level) => ({ read: 1, write: 2, admin: 3 })[level] ?? 0;

/** Problems with an installation token's permissions: errors refuse it, warnings are printed. */
export function permissionProblems(permissions) {
  const errors = [];
  const warnings = [];
  for (const [name, level] of Object.entries(REQUIRED)) {
    const has = permissions[name];
    if (rank(has) < rank(level)) errors.push(`missing ${name}: ${level}${has ? ` (has ${has})` : ''}`);
  }
  for (const [name, refuse] of Object.entries(REFUSED)) {
    const why = permissions[name] ? refuse(permissions[name]) : null;
    if (why) errors.push(why);
  }
  for (const [name, { level, why }] of Object.entries(EXPECTED)) {
    if (rank(permissions[name]) < rank(level)) warnings.push(`no ${name}: ${level}: ${why}`);
  }
  const known = new Set([...Object.keys(REQUIRED), ...Object.keys(EXPECTED), ...Object.keys(REFUSED)]);
  for (const [name, level] of Object.entries(permissions)) {
    if (!known.has(name)) warnings.push(`${name}: ${level} is not needed; remove it`);
    else if (REQUIRED[name] && rank(level) > rank(REQUIRED[name])) warnings.push(`${name}: ${level} is more than needed (${REQUIRED[name]})`);
  }
  return { errors, warnings };
}

async function main([key, appId, instId, repo]) {
  const { createSign } = await import('node:crypto');
  const { readFileSync } = await import('node:fs');
  const b64 = (x) => Buffer.from(x).toString('base64url');
  const iat = Math.floor(Date.now() / 1000) - 60;
  const head = b64(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ iat, exp: iat + 600, iss: appId }));
  const jwt = `${head}.${body}.${b64(createSign('RSA-SHA256').update(`${head}.${body}`).sign(readFileSync(key, 'utf8')))}`;
  const h = (auth) => ({ authorization: `Bearer ${auth}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });
  const app = await fetch('https://api.github.com/app', { headers: h(jwt) });
  if (!app.ok) throw new Error(`the key does not sign for App ${appId} (GitHub ${app.status})`);
  const t = await fetch(`https://api.github.com/app/installations/${instId}/access_tokens`, { method: 'POST', headers: h(jwt) });
  if (!t.ok) throw new Error(`could not mint a token for installation ${instId} (GitHub ${t.status})`);
  const { token, permissions } = await t.json();
  const r = await fetch('https://api.github.com/installation/repositories?per_page=100', { headers: h(token) });
  const repos = (await r.json()).repositories.map((x) => x.full_name.toLowerCase());
  console.log(`App ${appId} (${(await app.json()).slug}), installation ${instId}`);
  console.log(`reaches: ${repos.join(', ') || 'nothing'}`);
  console.log(`token permissions: ${Object.entries(permissions).map(([k, v]) => `${k}:${v}`).join(', ')}`);
  if (repos.length !== 1 || repos[0] !== repo.toLowerCase()) throw new Error(`the installation must reach exactly ${repo}`);
  const { errors, warnings } = permissionProblems(permissions);
  for (const w of warnings) console.log(`WARN: ${w}`);
  if (errors.length) throw new Error(errors.join('; '));
  console.log('OK: the key works, the installation reaches only the instance repo, and its permissions are what the harness needs');
}

// Run only when piped in with its arguments (`node -` sets argv[1] to "-"); an import runs nothing.
if (process.argv[1] === '-' && process.argv.length === 6) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`FAILED: ${e.message}`);
    process.exit(1);
  });
}
