<#
.SYNOPSIS
  Worklane's doctor on a Windows host: what mode this machine is in and what isolation it has, then the engine's own
  doctor inside the WSL2 distro. Changes nothing; no admin needed.

.DESCRIPTION
  "Windows host, WSL2 hardened" means agents run in the dedicated Worklane distro, whose isolation is Linux's (separate
  users and the sandbox) inside the WSL VM, with no Windows drives mounted and no interop. Without that distro this
  is "Windows host, native single-user": the dashboard and Issues work, agents don't.
  Exits 1 when a check fails (with -Hardened, a missing hardened setup is a failure too).

.EXAMPLE
  .\scripts\setup\windows\doctor.ps1
  .\scripts\setup\windows\doctor.ps1 -Instance shop -Repo owner/repo -Hardened
#>
[CmdletBinding()]
param(
  [string]$Instance,
  [string]$Repo,
  # Fail unless this machine is in WSL2 hardened mode.
  [switch]$Hardened
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')
$env:WSL_UTF8 = '1'
$Script:Failed = $false
function Report([string]$Status, [string]$Name, [string]$Detail) {
  if ($Status -eq 'fail') { $Script:Failed = $true }
  Write-Output ("{0,-5} {1}: {2}" -f $Status, $Name, $Detail)
}
function Finish { if ($Script:Failed) { exit 1 } else { exit 0 } }

if ($env:OS -ne 'Windows_NT') { Report 'fail' 'host' 'not a Windows host: run the engine''s own doctor (worklane doctor)'; Finish }

$single = 'Windows host, native single-user: the dashboard and Issues work here, agents don''t (no sandbox for Bash on Windows). For agents: scripts\setup\windows\install.ps1, run elevated.'
$singleStatus = if ($Hardened) { 'fail' } else { 'warn' }
$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
$status = 1
if ($wsl) { & wsl.exe --status *> $null; $status = $LASTEXITCODE }
if (-not $wsl -or $status -ne 0) { Report $singleStatus 'mode' "$single (WSL2 isn't installed)"; Finish }
$distro = @(ConvertFrom-WslList ((& wsl.exe -l -v 2>$null) -join "`n") | Where-Object Name -EQ $DistroName)
if (-not $distro.Count) { Report $singleStatus 'mode' "$single (no $DistroName distro)"; Finish }
if ($distro[0].Version -ne 2) { Report 'fail' 'mode' "$DistroName runs on WSL $($distro[0].Version); hardened mode needs WSL 2 (wsl --set-version $DistroName 2)"; Finish }

# The distro's isolation, as its /etc/wsl.conf sets it, and as the running system shows it.
$conf = ((& wsl.exe -d $DistroName -u root -- cat /etc/wsl.conf 2>$null) -join "`n")
$gaps = @(Get-WslConfGaps $conf)
$drives = ((& wsl.exe -d $DistroName -u root -- sh -c "grep -E 'aname=drvfs| drvfs ' /proc/mounts | cut -d' ' -f2" 2>$null) -join ' ').Trim()
if ($drives) { $gaps += "Windows drives are mounted ($drives)" }
$interop = ((& wsl.exe -d $DistroName -u root -- sh -c 'ls /proc/sys/fs/binfmt_misc/ 2>/dev/null | grep -c WSLInterop' 2>$null) -join '').Trim()
if ($interop -and $interop -ne '0') { $gaps += 'interop is on (Linux processes can start Windows programs)' }
$pid1 = ((& wsl.exe -d $DistroName -u root -- cat /proc/1/comm 2>$null) -join '').Trim()
if ($pid1 -ne 'systemd') { $gaps += "systemd isn't PID 1 ($pid1)" }
if ($gaps.Count) { Report 'fail' 'mode' "Windows host, WSL2, not hardened: $($gaps -join '; '). Run scripts\setup\windows\install.ps1 again, elevated." }
else { Report 'ok' 'mode' "Windows host, WSL2 hardened. Isolation: a separate VM from Windows (WSL2); Linux's users and sandbox inside it; no Windows drives mounted; no interop. The Windows account that owns the distro is trusted: it can enter it as root (wsl -d $DistroName -u root)." }

# Kept alive from boot.
$task = Get-ScheduledTask -TaskName $KeepAliveTask -ErrorAction SilentlyContinue
if (-not $task) { Report 'fail' 'keep-alive' "no scheduled task '$KeepAliveTask': WSL stops the distro when idle; run install.ps1 again" }
elseif ($task.State -ne 'Running') { Report 'warn' 'keep-alive' "'$KeepAliveTask' is $($task.State) (last result $((Get-ScheduledTaskInfo -TaskName $KeepAliveTask).LastTaskResult)); Start-ScheduledTask '$KeepAliveTask', or re-register it with install.ps1 -KeepAliveLogon Password if it can't start at boot" }
else { Report 'ok' 'keep-alive' "'$KeepAliveTask' is running; $DistroName is $($distro[0].State)" }

$wslconfig = Join-Path $env:USERPROFILE '.wslconfig'
$ini = if (Test-Path -LiteralPath $wslconfig) { ConvertFrom-IniText (Get-Content -Raw -LiteralPath $wslconfig) } else { @{} }
$idle = if ($ini.ContainsKey('wsl2') -and $ini['wsl2'].ContainsKey('vmidletimeout')) { $ini['wsl2']['vmidletimeout'] } else { '(unset)' }
$fwd = if ($ini.ContainsKey('wsl2') -and $ini['wsl2'].ContainsKey('localhostforwarding')) { $ini['wsl2']['localhostforwarding'] } else { 'true (default)' }
if ($idle -ne '-1') { Report 'warn' 'wslconfig' "[wsl2] vmIdleTimeout is $idle in $wslconfig; -1 keeps the VM up (install.ps1 sets it)" } else { Report 'ok' 'wslconfig' 'the VM never idles out' }
if ($fwd -eq 'false') { Report 'fail' 'dashboard' "[wsl2] localhostForwarding=false in ${wslconfig}: the dashboard can't be reached from Windows" }

if ($Instance) {
  if (-not (Test-InstanceName $Instance)) { Report 'fail' 'instance' "bad instance name '$Instance'"; Finish }
  $port = Get-InstancePort $Instance
  # Listening inside, reachable from Windows: the forward works. Not listening: the dashboard isn't running.
  $inside = ((& wsl.exe -d $DistroName -u root -- sh -c "ss -Hltn 'sport = :$port' | wc -l" 2>$null) -join '').Trim()
  if ($inside -eq '0' -or -not $inside) { Report 'ok' 'dashboard' "not running (start it: wsl -d $DistroName -u root -- bash $SetupDir/scripts/setup/dashboard.sh $Instance); it will be at http://127.0.0.1:$port" }
  elseif ((Test-NetConnection 127.0.0.1 -Port $port -WarningAction SilentlyContinue).TcpTestSucceeded) { Report 'ok' 'dashboard' "http://127.0.0.1:$port reaches the distro's dashboard" }
  else { Report 'fail' 'dashboard' "the dashboard listens in $DistroName on $port but Windows' 127.0.0.1:$port doesn't reach it: check [wsl2] localhostForwarding in $wslconfig, then wsl --shutdown" }
  if ($Repo) {
    if (-not (Test-RepoSlug $Repo)) { Report 'fail' 'instance' "bad repo '$Repo'"; Finish }
    # Where the setup put the checkouts: machine.json's `checkouts` (machine.sh --checkouts), else the default.
    $machine = ((& wsl.exe -d $DistroName -u root -- cat /etc/worklane/machine.json 2>$null) -join "`n")
    $checkouts = Get-CheckoutsRoot $machine
    $root = "$checkouts/$Instance/$(($Repo -split '/')[1])"
    Write-Output ''
    Write-Output "-- the engine's doctor, inside $DistroName, as wl-$Instance --"
    & wsl.exe -d $DistroName -u "wl-$Instance" -- worklane doctor --root $root --instance $Instance
    if ($LASTEXITCODE -ne 0) { $Script:Failed = $true }
  }
}
Finish
