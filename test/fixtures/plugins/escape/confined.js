// The escape fixture's guard (#608): server.js makes its write tries only where the broker's sandbox is meant to stop
// every one, and refuses anywhere else, before it holds an fs. Each fact is the kernel's (/proc/self, the process's own
// ids), never an environment variable a caller could set. Inside means all of:
//   - not root: uid and euid not 0, and no capabilities (as root its tries would land, /etc and /opt included);
//   - NoNewPrivs on: both units set NoNewPrivileges=yes (sandbox-runtime's bubblewrap sets it too);
//   - / mounted read-only where it runs (the top mount at /): both units have ProtectSystem=strict, and sandbox-runtime
//     binds / read-only again;
//   - its cgroup is one of the broker's units under system.slice: the broker's own (worklane-mcp@<instance>.service,
//     where sandbox-runtime runs it for a session) or a throwaway snapshot's (worklane-mcp-snapshot-<...>.service, the
//     quarantine preview). Only root makes a unit in system.slice; a login session, a user manager's units, WSL and
//     containers sit elsewhere.
// WHY not "the real /home isn't visible": in the broker's own unit it is (ProtectHome=read-only), so it marks nothing.
// Reads only: tests load this file to check the guard (test/mcp-broker-unit.test.ts), which never runs server.js's tries.
const fs = require('fs');

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/** This process's facts, as the kernel tells them. */
function facts() {
  return {
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    euid: typeof process.geteuid === 'function' ? process.geteuid() : null,
    status: read('/proc/self/status'),
    cgroup: read('/proc/self/cgroup'),
    mountinfo: read('/proc/self/mountinfo'),
  };
}

const UNIT = /^0::(\/system\.slice\/(?:[^/]+\.slice\/)*worklane-mcp(?:@[^/]+|-snapshot-[^/]+)\.service)$/m;

/** Why these facts are not the broker's sandbox (every reason, joined), or null when they are. */
function refusal(f) {
  const why = [];
  if (f.uid === null || f.euid === null) why.push('no uid to check (not Linux)');
  else if (f.uid === 0 || f.euid === 0) why.push(`runs as root (uid ${f.uid}, euid ${f.euid}; uid 0 never runs it, in any mode)`);
  if (f.status === null || f.cgroup === null || f.mountinfo === null) {
    why.push('cannot read /proc/self (status, cgroup, mountinfo)');
    return why.join('; ');
  }
  const field = (k) => (new RegExp(`^${k}:\\s*(\\S+)`, 'm').exec(f.status) || [])[1];
  const capEff = field('CapEff');
  if (capEff === undefined || !/^0+$/.test(capEff)) why.push(`has capabilities (CapEff ${capEff ?? 'unknown'})`);
  const nnp = field('NoNewPrivs');
  if (nnp !== '1') why.push(`NoNewPrivs is ${nnp ?? 'unknown'}, not 1 (the broker's units set NoNewPrivileges=yes)`);
  // mountinfo lists stacked mounts bottom first: the last at / is the one this process sees.
  const top = f.mountinfo.split('\n').map((l) => l.split(' ')).filter((x) => x[4] === '/').pop();
  if (!top) why.push('no mount at / in /proc/self/mountinfo');
  else if (!top[5].split(',').includes('ro')) why.push('/ is mounted read-write here (the broker\'s units mount it read-only: ProtectSystem=strict)');
  if (!UNIT.test(f.cgroup)) why.push(`its cgroup (${f.cgroup.trim().split('\n').join(', ')}) is not the MCP broker's unit or a snapshot unit in system.slice`);
  return why.length ? why.join('; ') : null;
}

module.exports = { facts, refusal };
