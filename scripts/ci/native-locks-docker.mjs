// Exercise the candidate package and the documented local volumes, never the host's installation/state.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'native-docker-'));
const tag = `native-locks-${process.pid}`;
const volumes = [`${tag}-state`, `${tag}-slots`];
const run = (cmd, args, timeout = 600000) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'] });
try {
  run('npm', ['run', 'build:web']);
  const pack = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', dir]))[0];
  cpSync(join(dir, pack.filename), join(dir, 'candidate.tgz'));
  mkdirSync(join(dir, 'scripts'));
  cpSync(join(root, 'scripts/bootstrap.sh'), join(dir, 'scripts/bootstrap.sh'));
  cpSync(join(root, 'package.json'), join(dir, 'package.json'));
  cpSync(join(root, 'examples/basic'), join(dir, 'fixture'), { recursive: true });
  const config = join(dir, 'fixture/.worklane/config.yaml');
  writeFileSync(config, readFileSync(config, 'utf8').replace('backlog: github', 'backlog: file'));
  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  const anchor = 'COPY --chown=user:user scripts/bootstrap.sh package.json /home/user/';
  if (!dockerfile.includes(anchor)) throw new Error('Docker install fixture anchor changed');
  writeFileSync(join(dir, 'Dockerfile'), dockerfile.replace(anchor, `${anchor}\nCOPY --chown=user:user candidate.tgz /home/user/candidate.tgz`) + '\nCOPY --chown=user:user fixture /repo\nRUN git -C /repo init -q -b main && git -C /repo add . && git -C /repo -c user.name=fixture -c user.email=fixture@example.com -c commit.gpgsign=false commit -qm fixture\n');
  console.log(run('docker', ['build', '--build-arg', 'ENGINE=file:/home/user/candidate.tgz', '-t', tag, dir]));
  for (const volume of volumes) run('docker', ['volume', 'create', volume]);
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs';
    import path from 'node:path';
    import {pathToFileURL} from 'node:url';
    import {execFileSync} from 'node:child_process';
    const cli=fs.realpathSync('/home/user/.local/bin/worklane');
    const moduleOf=(name)=>pathToFileURL(path.join(path.dirname(cli),name)).href;
    const {tryLock}=await import(moduleOf('locks.js'));
    const {projectStateDir}=await import(moduleOf('guardrails/context.js'));
    const state=projectStateDir('/repo'); fs.mkdirSync(state,{recursive:true});
    const resource=path.join(state,'smoke.lock');
    const held=tryLock(resource,'container'); assert.ok('lock' in held);
    assert.ok(!('lock' in tryLock(resource,'contender'))); held.lock.release();
    const next=tryLock(resource,'successor'); assert.ok('lock' in next); next.lock.release();
    const once=()=>execFileSync(process.execPath,[cli,'coordinator','run','--root','/repo','--once'],{encoding:'utf8',timeout:30000});
    once();
    const guard=path.join(state,'.coordinator.lock.flock');
    const before=fs.statSync(guard); assert.equal(fs.existsSync(path.join(state,'coordinator.lock')),false);
    once();
    const after=fs.statSync(guard); assert.deepEqual([before.dev,before.ino],[after.dev,after.ino]);
    assert.equal(fs.existsSync(path.join(state,'coordinator.lock')),false);
    console.log('candidate foreground coordinator ran twice; native ownership/release and persistent guard verified');
  `;
  console.log(run('docker', ['run', '--rm', '-v', `${volumes[0]}:/home/user/.local/state`, '-v', `${volumes[1]}:/home/user/.agent-slots`, tag, 'node', '--input-type=module', '-e', script], 90000));
} finally {
  for (const volume of volumes) { try { run('docker', ['volume', 'rm', volume], 10000); } catch {} }
  try { run('docker', ['image', 'rm', tag], 10000); } catch {}
  rmSync(dir, { recursive: true, force: true });
}
