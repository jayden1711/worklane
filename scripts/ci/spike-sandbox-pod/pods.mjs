// SPIKE (do not merge), #698 decision 5. The probe pods, one per profile.
//   node pods.mjs list                       the profiles, one per line: <name> <namespaces to try, in order>
//   node pods.mjs pod <profile> <ns> <name>  that profile's Pod as JSON (kubectl apply -f -)
// Every pod runs the same image (probe.sh) as uid 1000 with a read-only root and an emptyDir /tmp, no service
// account token. The profiles differ only in the security settings named.
const restrictedPod = { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } };
const restrictedCtr = { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] }, readOnlyRootFilesystem: true };
// Docker's default seccomp profile plus clone/unshare with namespace flags, mount, umount2 and pivot_root (run.sh).
const nsSeccomp = { type: 'Localhost', localhostProfile: 'profiles/spike-ns.json' };

/** name -> { ns: namespaces to try in order (the first that admits it), pod, ctr, spec extras } */
const PROFILES = {
  // Pod Security "restricted": runAsNonRoot, no privilege escalation, every capability dropped, seccomp RuntimeDefault.
  restricted: { ns: ['restricted'], pod: restrictedPod, ctr: restrictedCtr },
  // The same, plus the runtime's default AppArmor profile.
  'restricted+apparmor': { ns: ['restricted'], pod: { ...restrictedPod, appArmorProfile: { type: 'RuntimeDefault' } }, ctr: restrictedCtr },
  // Pod Security "baseline" with nothing set beyond the user: seccomp and AppArmor are whatever the node defaults to.
  baseline: { ns: ['baseline'], pod: { runAsUser: 1000, runAsGroup: 1000 }, ctr: { readOnlyRootFilesystem: true } },
  // restricted in a Kubernetes user namespace (hostUsers: false).
  'restricted+userns': { ns: ['restricted'], pod: restrictedPod, ctr: restrictedCtr, spec: { hostUsers: false } },
  // restricted with a Localhost seccomp profile that allows namespace syscalls (restricted admits Localhost).
  'restricted+ns-seccomp': { ns: ['restricted'], pod: { ...restrictedPod, seccompProfile: nsSeccomp }, ctr: restrictedCtr },
  'restricted+ns-seccomp+userns': { ns: ['restricted'], pod: { ...restrictedPod, seccompProfile: nsSeccomp }, ctr: restrictedCtr, spec: { hostUsers: false } },
  // ... and an unmasked /proc, so a fresh proc mount is allowed. Tried under restricted first, then baseline, then
  // privileged: the first that admits it is the level it needs.
  'ns-seccomp+userns+unmasked-proc': {
    ns: ['restricted', 'baseline', 'privileged'],
    pod: { ...restrictedPod, seccompProfile: nsSeccomp },
    ctr: { ...restrictedCtr, procMount: 'Unmasked' },
    spec: { hostUsers: false },
  },
  // restricted under gVisor (only when run.sh installed it: GVISOR=1).
  'restricted+gvisor': { ns: ['restricted'], pod: restrictedPod, ctr: restrictedCtr, spec: { runtimeClassName: 'gvisor' }, gvisor: true },
};

const [cmd, profile, ns, name] = process.argv.slice(2);
if (cmd === 'list') {
  for (const [n, p] of Object.entries(PROFILES)) if (!p.gvisor || process.env.GVISOR === '1') console.log(`${n} ${p.ns.join(',')}`);
} else if (cmd === 'pod') {
  const p = PROFILES[profile];
  if (!p) throw new Error(`no profile ${profile}`);
  const pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace: `spike-${ns}`, labels: { 'spike-profile': profile.replace(/[^a-z0-9-]/g, '_') } },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      securityContext: p.pod,
      ...(p.spec ?? {}),
      containers: [
        {
          name: 'probe',
          image: 'spike-probe:1',
          imagePullPolicy: 'Never',
          securityContext: p.ctr,
          volumeMounts: [{ name: 'tmp', mountPath: '/tmp' }],
        },
      ],
      volumes: [{ name: 'tmp', emptyDir: {} }],
    },
  };
  console.log(JSON.stringify(pod));
} else {
  throw new Error('usage: pods.mjs list | pod <profile> <ns> <name>');
}
