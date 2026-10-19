// doctor's lines for a machine instance's policy.yaml (issue #726, src/policy-gate.ts): once root's record covers it,
// whether it is still root's (a failure when not: the engine refuses it, so the coordinator won't start); before that,
// on a machine install (the machine helper is there), a warning that the coordinator user can rewrite it, naming the
// root command that makes it root's with its content kept. Nothing here on a laptop, cloud or VM install.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DoctorCheck } from './doctor.js';
import { instancesDir, listInstances } from './instance.js';
import { MACHINE_HELPER } from './machine.js';
import { readRootFile } from './os/root-file.js';
import { ownCommand, POLICY_ROOT_DIR, policyRootRequired, readPolicyChecked } from './policy-gate.js';
import { idPointerPath, instanceId, sharedWith } from './policy-kill.js';

export function policyRootChecks(dir = instancesDir(), o: { machine?: boolean; markers?: string } = {}): DoctorCheck[] {
  const machine = o.machine ?? existsSync(MACHINE_HELPER);
  const markers = o.markers ?? POLICY_ROOT_DIR;
  const out: DoctorCheck[] = [];
  for (const name of listInstances(dir)) {
    const file = join(dir, name, 'policy.yaml');
    const check = (level: DoctorCheck['level'], detail: string) => out.push({ name: `policy owner ${name}`, level, detail });
    if (policyRootRequired(name, markers)) {
      const r = readPolicyChecked(file, markers, name);
      if (r && 'refused' in r) check('fail', `${r.refused}. Until then the coordinator won't start.`);
      else check('ok', `${file} is root's; only root changes it`);
    } else if (machine) {
      const r = readRootFile(file);
      const why = 'problem' in r ? r.problem : `${file} is root's, but not recorded as such`;
      check('warn', `${why}: the coordinator user, or anything running as it, can rewrite it (sandbox, allow_same_user, land_mode). An admin makes it root's, its content kept and its keys shown: ${ownCommand(name)} (or reruns add-project.sh)`);
    }
    // Root's id pointer (#726 round 9): one that can't be used, or a taken-over instance with none, reads auto_merge
    // off; another name with the same id is a rename under way, or one that stopped.
    const id = instanceId(name, markers);
    const ptr = idPointerPath(name, markers);
    const idCheck = (level: DoctorCheck['level'], detail: string) => out.push({ name: `auto_merge id ${name}`, level, detail });
    if (id && 'problem' in id) idCheck('fail', `root's ${ptr} can't be used (${id.problem}): auto_merge reads off, and auto_merge off fails, until an admin runs ${ownCommand(name, '--retake')}`);
    else if (!id && policyRootRequired(name, markers)) idCheck('fail', `no ${ptr} for a policy root took over: auto_merge reads off until an admin runs ${ownCommand(name, '--retake')}`);
    else if (id) {
      const shared = sharedWith(name, markers);
      if (shared.length) idCheck('warn', `${shared.join(', ')} shares ${name}'s id: auto_merge off for either turns both off, and root's set on is refused. Expected while a rename runs; otherwise an admin finishes it or undoes it (instance-rename.sh --yes or --abort)`);
    }
  }
  return out;
}
