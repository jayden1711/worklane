import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instancePort } from '../src/dashboard.js';
import { doctor } from '../src/doctor.js';
import { install } from '../src/install.js';
import { which } from '../src/os/index.js';
import { HARDENED_WSL_CONF, hostSummary, parseIni, parseMounts, wslCheckoutRefusal, wslGpu, wslIsolation, type WslFacts } from '../src/os/windows/wsl.js';
import { repoRoot } from './helpers.js';

const win = join(repoRoot, 'scripts', 'setup', 'windows');
const lib = readFileSync(join(win, 'lib.ps1'), 'utf8');
const installPs1 = readFileSync(join(win, 'install.ps1'), 'utf8');

// /proc/mounts lines as WSL2 writes them (a Windows drive over 9p; the GPU driver share; the distro's own disk).
const DRIVE_C = 'C:\\134 /mnt/c 9p rw,noatime,dirsync,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=5,wfd=5 0 0';
const DRIVERS = 'drivers /usr/lib/wsl/drivers 9p ro,nosuid,nodev,noatime,dirsync,aname=drivers;fmask=222;dmask=222,mmap,access=client,msize=65536,trans=fd,rfd=7,wfd=7 0 0';
const ROOT = '/dev/sdc / ext4 rw,relatime,discard,errors=remount-ro,data=ordered 0 0';
const hardenedConf = Object.entries(HARDENED_WSL_CONF).map(([s, kv]) => `[${s}]\n${Object.entries(kv).map(([k, v]) => `${k}=${v}`).join('\n')}`).join('\n\n');
const hardened: WslFacts = { wslConf: hardenedConf, mounts: [ROOT, DRIVERS].join('\n'), interop: false, systemd: true };
const open: WslFacts = { wslConf: '[boot]\nsystemd=false\n', mounts: [ROOT, DRIVERS, DRIVE_C].join('\n'), interop: true, systemd: false };

test('the hardened wsl.conf the installer writes is the one the doctor checks', () => {
  const m = lib.match(/\$Script:HardenedWslConf = @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(m, 'lib.ps1 has the hardened wsl.conf');
  const fromPs1 = parseIni(m[1]!);
  const want = Object.fromEntries(Object.entries(HARDENED_WSL_CONF).map(([s, kv]) => [s.toLowerCase(), Object.fromEntries(Object.entries(kv).map(([k, v]) => [k.toLowerCase(), v]))]));
  assert.deepEqual(fromPs1, want);
});

test('isolation: hardened has Linux inside the VM with no Windows drives and no interop; each gap is named with its fix', () => {
  const ok = wslIsolation(hardened);
  assert.equal(ok.hardened, true, ok.gaps.join('\n'));
  assert.deepEqual(ok.has, ['a separate VM from Windows (WSL2)', "Linux's users and sandbox inside it", 'no Windows drives mounted', 'no interop (Linux processes cannot start Windows programs)']);
  const bad = wslIsolation(open);
  assert.equal(bad.hardened, false);
  assert.match(bad.gaps.join('\n'), /Windows drives are mounted \(\/mnt\/c\): set \[automount\] enabled=false/);
  assert.match(bad.gaps.join('\n'), /interop is on.*set \[interop\] enabled=false/);
  assert.match(bad.gaps.join('\n'), /appendWindowsPath=false/);
  assert.match(bad.gaps.join('\n'), /systemd is not running/);
  assert.match(bad.gaps.at(-1)!, /wsl --terminate/);
});

test('mounts: the Windows drive is found (escapes decoded); the GPU driver share and the distro disk are not drives', () => {
  const m = parseMounts([ROOT, DRIVERS, DRIVE_C].join('\n'));
  assert.equal(m[2]!.device, 'C:\\');
  assert.deepEqual(wslIsolation({ ...hardened, mounts: [ROOT, DRIVERS].join('\n') }).gaps, []);
  assert.deepEqual(parseMounts('a /mnt/my\\040drive drvfs rw 0 0')[0]!.point, '/mnt/my drive');
});

test('checkouts: refused anywhere under /mnt or on a Windows drive mounted elsewhere; fine on the distro\'s own disk', () => {
  const mounts = [ROOT, DRIVE_C, 'D:\\134 /win 9p rw,aname=drvfs;path=D:\\ 0 0'].join('\n');
  assert.match(wslCheckoutRefusal('/mnt/c/Users/me/src/app', mounts)!, /is on the Windows drive mounted at \/mnt\/c\. Checkouts must live on WSL's own filesystem/);
  assert.match(wslCheckoutRefusal('/mnt/wsl/shared', mounts)!, /is on \/mnt, where WSL mounts Windows drives/);
  assert.match(wslCheckoutRefusal('/win/repo', mounts)!, /mounted at \/win/);
  assert.equal(wslCheckoutRefusal('/home/me/src/app', mounts), null);
  assert.equal(wslCheckoutRefusal('/mntx/app', mounts), null);
  assert.equal(wslCheckoutRefusal('/srv/worklane/shop/app', mounts), null);
});

test('GPU: NVIDIA under WSL2 is found through /usr/lib/wsl/lib, not PCI', () => {
  const files = new Set(['/dev/dxg', '/usr/lib/wsl/lib/nvidia-smi', '/usr/lib/wsl/lib/libcuda.so.1']);
  assert.deepEqual(wslGpu((p) => files.has(p)), { dxg: true, nvidiaSmi: '/usr/lib/wsl/lib/nvidia-smi', cuda: true });
  assert.deepEqual(wslGpu(() => false), { dxg: false, nvidiaSmi: null, cuda: false });
});

test('the host line: WSL2 hardened, WSL2 not hardened (with what is open), native Windows single-user', () => {
  assert.deepEqual(hostSummary('windows-wsl', wslIsolation(hardened), false), { status: 'ok', detail: "Windows host, WSL2 hardened. Isolation: a separate VM from Windows (WSL2); Linux's users and sandbox inside it; no Windows drives mounted; no interop (Linux processes cannot start Windows programs)." });
  const notHardened = hostSummary('windows-wsl', wslIsolation(open), false);
  assert.equal(notHardened.status, 'warn');
  assert.match(notHardened.detail, /^Windows host, WSL2, not hardened\. Has: .*Open:\n- Windows drives are mounted/s);
  const native = hostSummary('windows', null, true);
  assert.equal(native.status, 'warn');
  assert.match(native.detail, /^Windows host, native single-user: the dashboard and Issues work here, agents don't.*install\.ps1, run elevated/);
});

function wslRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'wsl-doctor-'));
  cpSync(join(repoRoot, 'examples', 'basic'), dir, { recursive: true });
  const cfg = join(dir, '.worklane', 'config.yaml');
  writeFileSync(cfg, readFileSync(cfg, 'utf8').replace(/^os: auto\b/m, 'os: windows-wsl'));
  return dir;
}

test('doctor under WSL: the host line, the GPU, and a checkout on a Windows drive fails', () => {
  const dir = wslRepo();
  const gpu = { dxg: true, nvidiaSmi: '/usr/lib/wsl/lib/nvidia-smi', cuda: true };
  const ok = doctor(dir, { wsl: { facts: hardened, gpu } });
  const os = ok.find((c) => c.name === 'os')!;
  assert.equal(os.level, 'ok');
  assert.match(os.detail, /^Windows host, WSL2 hardened\. Isolation: /);
  assert.equal(ok.find((c) => c.name === 'gpu')?.detail, 'NVIDIA through WSL (/usr/lib/wsl/lib/nvidia-smi, CUDA driver present)');
  assert.equal(ok.find((c) => c.name === 'checkout'), undefined);
  // The same checkout, as if it sat on a Windows drive: a drvfs mount at its parent.
  const parent = join(dir, '..').replace(/\\/g, '/');
  const onDrive = doctor(dir, { wsl: { facts: { ...hardened, mounts: `${ROOT}\nC:\\134 ${parent} 9p rw,aname=drvfs;path=C:\\ 0 0` }, gpu } });
  assert.equal(onDrive.find((c) => c.name === 'checkout')?.level, 'fail');
  assert.equal(doctor(dir, { wsl: { facts: open, gpu } }).find((c) => c.name === 'os')?.level, 'warn');
});

test('install under WSL refuses a checkout under /mnt before writing anything', { skip: process.platform === 'win32' && 'POSIX paths' }, () => {
  assert.throws(() => install({ root: '/mnt/c/Users/me/src/app', os: 'windows-wsl', mounts: DRIVE_C }), /Checkouts must live on WSL's own filesystem/);
});

test('native Windows doctor: single-user, with the way to hardened mode', { skip: process.platform !== 'win32' && 'native Windows only' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'win-doctor-'));
  cpSync(join(repoRoot, 'examples', 'basic'), dir, { recursive: true });
  const os = doctor(dir).find((c) => c.name === 'os')!;
  assert.equal(os.level, 'warn');
  assert.match(os.detail, /^Windows host, native single-user/);
});

test('bootstrap under WSL refuses a repo under /mnt', { skip: process.platform === 'win32' && 'bash script' }, () => {
  const r = spawnSync('bash', [join(repoRoot, 'scripts', 'bootstrap.sh'), '--dry-run', '/mnt/c/Users/me/app'], { encoding: 'utf8', env: { ...process.env, WSL_DISTRO_NAME: 'Test' } });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /under \/mnt, where WSL mounts Windows drives: clone the repo on WSL's own filesystem/);
});

test('setup scripts under WSL: the checkouts root (machine.json, --checkouts) never under /mnt or on a Windows drive', { skip: process.platform === 'win32' && 'bash script' }, () => {
  const mounts = join(mkdtempSync(join(tmpdir(), 'mounts-')), 'mounts');
  writeFileSync(mounts, [ROOT, DRIVE_C, 'D:\\134 /data 9p rw,aname=drvfs;path=D:\\ 0 0'].join('\n'));
  const lib = join(repoRoot, 'scripts', 'setup', 'lib.sh');
  const check = (path: string, wsl: boolean) => spawnSync('bash', ['-c', `source "$1"; refuse_windows_fs "$2"`, 'x', lib, path], { encoding: 'utf8', env: { ...process.env, MOUNTS: mounts, WSL_DISTRO_NAME: wsl ? 'Worklane' : '' } });
  assert.match(check('/mnt/c/worklane', true).stderr, /under \/mnt, where WSL mounts Windows drives/);
  assert.match(check('/data/worklane', true).stderr, /on the Windows drive mounted at \/data/);
  assert.equal(check('/srv/worklane', true).status, 0);
  assert.equal(check('/database/worklane', true).status, 0, 'a prefix of a mount point is not inside it');
  if (process.platform !== 'linux') assert.equal(check('/mnt/c/worklane', false).status, 0, 'only inside WSL');
  const setup = join(repoRoot, 'scripts', 'setup');
  assert.match(readFileSync(join(setup, 'machine.sh'), 'utf8'), /refuse_windows_fs "\$checkouts" \|\| exit 2/);
  assert.match(readFileSync(join(setup, 'checkout.sh'), 'utf8'), /dest="\$\(checkouts_root\)[^\n]*\nrefuse_windows_fs "\$dest" \|\| exit 1/);
});

test('the WSL isolation probe: passes on a hardened distro, names each thing open otherwise', { skip: process.platform === 'win32' && 'bash script' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'iso-'));
  const files = (name: string, f: WslFacts, interop: boolean) => {
    writeFileSync(join(dir, `${name}.mounts`), f.mounts);
    writeFileSync(join(dir, `${name}.conf`), f.wslConf ?? '');
    writeFileSync(join(dir, `${name}.comm`), f.systemd ? 'systemd\n' : 'init\n');
    const binfmt = mkdtempSync(join(dir, `${name}-binfmt-`));
    if (interop) writeFileSync(join(binfmt, 'WSLInterop'), 'enabled\n');
    return { MOUNTS: join(dir, `${name}.mounts`), WSL_CONF: join(dir, `${name}.conf`), PID1_COMM: join(dir, `${name}.comm`), BINFMT_DIR: binfmt, PATH: '/usr/bin:/bin' };
  };
  const run = (env: Record<string, string>) => spawnSync('bash', [join(win, 'isolation-check.sh')], { encoding: 'utf8', env: { ...process.env, ...env } });
  const good = run(files('good', hardened, false));
  assert.equal(good.status, 0, good.stdout);
  assert.doesNotMatch(good.stdout, /FAIL/);
  const bad = run(files('bad', open, true));
  assert.equal(bad.status, 1);
  for (const want of [/FAIL  Windows drives mounted: \/mnt\/c/, /FAIL  interop registered/, /FAIL  PID 1 is init, not systemd/, /FAIL  wsl.conf lacks appendwindowspath=false/]) assert.match(bad.stdout, want);
});

test('the installer downloads only what is pinned, checks it before importing, and never runs downloaded code', () => {
  const sha = lib.match(/Sha256\s*=\s*'([0-9a-f]+)'/)?.[1];
  assert.match(sha ?? '', /^[0-9a-f]{64}$/);
  const name = lib.match(/\bName\s*=\s*'([^']+\.wsl)'/)?.[1] ?? '';
  assert.match(name, /^ubuntu-\d+\.\d+\.\d+-wsl-amd64\.wsl$/, 'a fixed point release, never "current" or "latest"');
  const urls = [...lib.matchAll(/'(https?:\/\/[^']+)'/g)].map((m) => m[1]!);
  assert.ok(urls.length >= 1);
  for (const u of urls) {
    assert.match(u, /^https:\/\//);
    assert.ok(u.endsWith(`/${name}`), `${u} is the pinned file`);
  }
  // Every download is a pinned URL, checked right after; the import comes after the check.
  const downloads = [...installPs1.matchAll(/Invoke-WebRequest[^\n]*/g)].map((m) => m[0]);
  assert.deepEqual(downloads, ['Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file']);
  assert.match(installPs1, /foreach \(\$url in \$Pins\.Distro\.Urls\)/);
  assert.ok(installPs1.indexOf('Assert-PinnedFile -Path $file -Sha256 $Pins.Distro.Sha256 -DeleteOnMismatch') < installPs1.indexOf("& wsl.exe --import"));
  assert.doesNotMatch(installPs1 + lib, /Invoke-Expression|\biex\b|\birm\b|curl[^\n]*\|\s*(ba)?sh|DownloadString/i);
});

// ------------------------------------------------------------------------------------- PowerShell itself

const shell = process.platform === 'win32' ? 'powershell.exe' : which('pwsh') ? 'pwsh' : null;
const skipPs = !shell && 'no PowerShell here (CI runs these on Windows PowerShell 5.1, and pwsh on Linux and macOS)';
const ps = (command: string) => spawnSync(shell!, ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', timeout: 120_000 });
const psFile = (file: string, args: string[]) => spawnSync(shell!, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(win, file), ...args], { encoding: 'utf8', timeout: 120_000 });
const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

test('PowerShell: the scripts parse', { skip: skipPs }, () => {
  for (const f of ['lib.ps1', 'install.ps1', 'doctor.ps1']) {
    const r = ps(`$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile(${q(join(win, f))}, [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.ToString() }; exit 1 }`);
    assert.equal(r.status, 0, `${f}: ${r.stdout}${r.stderr}`);
  }
});

test('PowerShell: the dashboard port matches the engine\'s; .wslconfig keeps what was there; wsl.conf gaps; wsl -l -v', { skip: skipPs }, () => {
  const names = ['shop', 'a', 'demo-2', 'x1'];
  const r = ps(`. ${q(join(win, 'lib.ps1'))}; ${names.map((n) => `Get-InstancePort ${q(n)}`).join('; ')}`);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stdout.trim().split(/\r?\n/).map(Number), names.map(instancePort));
  const merged = ps(`. ${q(join(win, 'lib.ps1'))}; Merge-IniText "[wsl2]\`r\`nmemory=8GB\`r\`nvmIdleTimeout=60000\`r\`n\`r\`n[experimental]\`r\`nsparseVhd=true" $WslConfigKeys`);
  assert.equal(merged.status, 0, merged.stderr);
  assert.deepEqual(merged.stdout.trim().split(/\r?\n/), ['[wsl2]', 'memory=8GB', 'vmIdleTimeout=-1', 'localhostForwarding=true', '', '[experimental]', 'sparseVhd=true']);
  const gaps = ps(`. ${q(join(win, 'lib.ps1'))}; (Get-WslConfGaps $HardenedWslConf).Count; (Get-WslConfGaps "[boot]\`nsystemd=true").Count`);
  assert.deepEqual(gaps.stdout.trim().split(/\r?\n/).map(Number), [0, 5]);
  const list = ps(`. ${q(join(win, 'lib.ps1'))}; ConvertFrom-WslList "  NAME      STATE           VERSION\`n* Ubuntu    Running         2\`n  Worklane  Stopped         2\`n" | ForEach-Object { "$($_.Name) $($_.State) $($_.Version) $($_.Default)" }`);
  assert.deepEqual(list.stdout.trim().split(/\r?\n/), ['Ubuntu Running 2 True', 'Worklane Stopped 2 False']);
  const roots = ps(`. ${q(join(win, 'lib.ps1'))}; Get-CheckoutsRoot '{"max_cap":16,"checkouts":"/data/worklane"}'; Get-CheckoutsRoot ''; Get-CheckoutsRoot '{"checkouts":"relative"}'`);
  assert.deepEqual(roots.stdout.trim().split(/\r?\n/), ['/data/worklane', '/srv/worklane', '/srv/worklane']);
});

test('PowerShell: the installer\'s dry run shows the whole plan and changes nothing', { skip: skipPs }, () => {
  const r = psFile('install.ps1', ['-Instance', 'shop', '-Repo', 'owner/repo', '-DryRun']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = r.stdout;
  for (const want of [
    'dry run: nothing is changed',
    'would run: wsl.exe --install --no-distribution',
    'would download https://releases.ubuntu.com/noble/ubuntu-24.04.5-wsl-amd64.wsl (sha256 bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e) and refuse it unless it matches',
    'would run: wsl.exe --import Worklane',
    '| systemd=true',
    '| enabled=false',
    '| appendWindowsPath=false',
    'would run: wsl.exe --terminate Worklane',
    `bootstrap.sh --hardened shop owner/repo`,
    'vmIdleTimeout=-1',
    'localhostForwarding=true',
    "would register scheduled task 'Worklane WSL keep-alive'",
    '-d Worklane --exec /bin/sleep infinity',
    `http://127.0.0.1:${instancePort('shop')}`,
  ]) assert.ok(out.includes(want), `missing: ${want}\n${out}`);
});

test('PowerShell: a distro image that is not the pinned one is refused before anything is imported', { skip: skipPs }, () => {
  const bogus = join(mkdtempSync(join(tmpdir(), 'distro-')), 'ubuntu-24.04.5-wsl-amd64.wsl');
  writeFileSync(bogus, 'not the image');
  const r = psFile('install.ps1', ['-Instance', 'shop', '-Repo', 'owner/repo', '-DryRun', '-DistroFile', bogus]);
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /checksum mismatch for .*want bb415d82.*nothing was imported/s);
  assert.doesNotMatch(r.stdout, /would run: wsl\.exe --import/);
  const badName = psFile('install.ps1', ['-Instance', 'Shop!', '-Repo', 'owner/repo', '-DryRun']);
  assert.notEqual(badName.status, 0);
  assert.match(badName.stdout + badName.stderr, /instance name must be lowercase/);
});

test('PowerShell: the Windows doctor on a host without the distro says single-user, and fails with -Hardened', { skip: (process.platform !== 'win32' && 'Windows only') || skipPs }, () => {
  const r = psFile('doctor.ps1', []);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /mode: Windows host, native single-user/);
  const h = psFile('doctor.ps1', ['-Hardened']);
  assert.equal(h.status, 1, h.stdout);
  assert.match(h.stdout, /^fail\s+mode: Windows host, native single-user/m);
});
