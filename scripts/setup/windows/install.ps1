<#
.SYNOPSIS
  Worklane on Windows, hardened: a dedicated WSL2 distro running the Linux multi-user setup.

.DESCRIPTION
  Read it first, then run it in an elevated PowerShell from your own Windows account (the distro and its keep-alive
  belong to the account that runs this). Each step checks first, so running it again does only what's missing.

    1. WSL2: installed and at least version 2 (Microsoft's own component, through wsl.exe).
    2. The distro: Ubuntu 24.04's WSL image, pinned by sha256 (lib.ps1), imported as "Worklane". Nothing unpinned is
       downloaded, and nothing is piped from the network into a shell.
    3. /etc/wsl.conf in it: systemd on; no Windows drives mounted and no interop, so nothing in the distro can reach
       your Windows files or start Windows programs as you.
    4. The engine's setup scripts copied in, and the Linux hardened bootstrap run inside (each step shown for review).
    5. %USERPROFILE%\.wslconfig: the VM never idles out, and 127.0.0.1 forwards to the distro (the dashboard).
    6. A scheduled task that keeps the distro running, from boot.

  Then, by hand: the instance's credentials inside the distro, and this script again with -AfterCredentials.

.EXAMPLE
  .\scripts\setup\windows\install.ps1 -Instance shop -Repo owner/repo -DryRun
  .\scripts\setup\windows\install.ps1 -Instance shop -Repo owner/repo
  .\scripts\setup\windows\install.ps1 -Instance shop -Repo owner/repo -AfterCredentials
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Instance,
  [Parameter(Mandatory = $true)][string]$Repo,
  # Print what it would do; change nothing (no admin needed).
  [switch]$DryRun,
  # The distro image, already downloaded (checked against the same pin).
  [string]$DistroFile,
  # Where the distro's disk lives.
  [string]$InstallDir = $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Worklane\wsl' } else { 'C:\Worklane\wsl' }),
  # Don't stop to show each Linux setup step for review.
  [switch]$Yes,
  # After the credentials: clone the repo, start the services and check them.
  [switch]$AfterCredentials,
  # The keep-alive task's logon: S4U (no stored password; the default) or Password (asks for yours, stored by Windows).
  [ValidateSet('S4U', 'Password')][string]$KeepAliveLogon = 'S4U'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'lib.ps1')

if (-not (Test-InstanceName $Instance)) { throw "instance name must be lowercase letters, digits and dashes (got '$Instance')" }
if (-not (Test-RepoSlug $Repo)) { throw "the repo must be owner/name (got '$Repo')" }
$EngineRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$Port = Get-InstancePort $Instance
$env:WSL_UTF8 = '1'  # wsl.exe's own output in UTF-8, not UTF-16

function Invoke-Step([string]$Display, [scriptblock]$Action) {
  if ($DryRun) { Write-Output "   would run: $Display"; return }
  $global:LASTEXITCODE = 0
  & $Action
  if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "failed ($LASTEXITCODE): $Display" }
}
function Invoke-InDistro([string]$Command, [string]$Stdin) {
  $display = "wsl.exe -d $DistroName -u root -- bash -c `"$Command`""
  if ($DryRun) { Write-Output "   would run: $display"; return }
  if ($PSBoundParameters.ContainsKey('Stdin')) { $Stdin | & wsl.exe -d $DistroName -u root -- bash -c $Command }
  else { & wsl.exe -d $DistroName -u root -- bash -c $Command }
  if ($LASTEXITCODE -ne 0) { throw "failed ($LASTEXITCODE): $display" }
}
function Get-Distros { return ConvertFrom-WslList ((& wsl.exe -l -v 2>$null) -join "`n") }

# ------------------------------------------------------------------------------------------------ checks

Write-Step 'this machine'
if ($DryRun) {
  Write-Output '   dry run: nothing is changed, and no admin rights are needed'
} else {
  if ($env:OS -ne 'Windows_NT') { throw 'install.ps1 runs on Windows' }
  $build = [System.Environment]::OSVersion.Version.Build
  if ($build -lt 19041) { throw "WSL2 needs Windows 10 build 19041 or newer (this is $build)" }
  if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') { throw "the pinned distro image is for x64 Windows (this is $env:PROCESSOR_ARCHITECTURE)" }
  $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  if (-not $admin) { throw 'run this from an elevated PowerShell (Run as administrator), in your own account' }
  Write-Output "   ok: Windows build $build, elevated, as $env:USERDOMAIN\$env:USERNAME"
}

if ($AfterCredentials) {
  Write-Step "Linux setup, after the credentials (inside $DistroName)"
  $yes = if ($Yes) { ' --yes' } else { '' }
  Invoke-InDistro "bash $SetupDir/scripts/bootstrap.sh --hardened --after-credentials$yes $Instance $Repo"
  Write-Step 'the dashboard, from Windows'
  Write-Output "   start it in a terminal: wsl -d $DistroName -u root -- bash $SetupDir/scripts/setup/dashboard.sh $Instance [<your GitHub login>]"
  Write-Output "   it listens on the distro's 127.0.0.1:$Port, which WSL forwards to Windows' 127.0.0.1:$Port: open the URL it prints (with its token) in a Windows browser"
  Write-Output "   then: .\scripts\setup\windows\doctor.ps1 -Instance $Instance -Repo $Repo"
  exit 0
}

# ------------------------------------------------------------------------------------------------ 1. WSL2

Write-Step 'WSL2'
if ($DryRun) { Write-Output '   would run: wsl.exe --install --no-distribution (if WSL is missing), then wsl.exe --update' }
else {
  & wsl.exe --status *> $null
  if ($LASTEXITCODE -ne 0) {
    & wsl.exe --install --no-distribution
    & wsl.exe --status *> $null
    if ($LASTEXITCODE -ne 0) { Write-Output '   WSL was just enabled: restart Windows, then run this script again.'; exit 3 }
  }
  & wsl.exe --update
  $v = ((& wsl.exe --version) -join "`n") -replace "`0", ''
  if ($v -notmatch 'WSL[^:]*:\s*(\d+)\.') { throw "can't read the WSL version (wsl --version: $v); systemd needs WSL 2 or newer" }
  if ([int]$Matches[1] -lt 2) { throw "WSL $($Matches[0]) is too old for systemd: run wsl --update" }
  Write-Output "   ok: $(($v -split "`n")[0])"
}

# ------------------------------------------------------------------------------------------------ 2. the distro

Write-Step "the $DistroName distro ($($Pins.Distro.Name), sha256 $($Pins.Distro.Sha256))"
$existing = if ($DryRun) { @() } else { @(Get-Distros | Where-Object Name -EQ $DistroName) }
if ($existing.Count -and $existing[0].Version -ne 2) { throw "a $DistroName distro exists but runs WSL $($existing[0].Version); remove it (wsl --unregister $DistroName) or convert it (wsl --set-version $DistroName 2)" }
if ($existing.Count) { Write-Output "   ok: $DistroName is imported (WSL 2)" }
else {
  $file = $DistroFile
  if ($file) {
    Assert-PinnedFile -Path $file -Sha256 $Pins.Distro.Sha256
    Write-Output "   ok: $file matches the pin"
  } elseif ($DryRun) {
    Write-Output "   would download $($Pins.Distro.Urls[0]) (sha256 $($Pins.Distro.Sha256)) and refuse it unless it matches"
    $file = "<download>\$($Pins.Distro.Name)"
  } else {
    $dir = Join-Path $env:TEMP 'worklane-wsl'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $file = Join-Path $dir $Pins.Distro.Name
    $done = $false
    foreach ($url in $Pins.Distro.Urls) {
      try {
        Write-Output "   downloading $url"
        Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file
        Assert-PinnedFile -Path $file -Sha256 $Pins.Distro.Sha256 -DeleteOnMismatch
        $done = $true; break
      } catch { Write-Warning "$url : $($_.Exception.Message)" }
    }
    if (-not $done) { throw "no pinned copy of $($Pins.Distro.Name) could be downloaded and verified" }
  }
  Invoke-Step "wsl.exe --import $DistroName `"$InstallDir`" `"$file`" --version 2" {
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    & wsl.exe --import $DistroName $InstallDir $file --version 2
  }
}

# ------------------------------------------------------------------------------------------------ 3. wsl.conf

Write-Step "/etc/wsl.conf in $DistroName (systemd; no Windows drives; no interop)"
if ($DryRun) { $HardenedWslConf -split "`n" | ForEach-Object { Write-Output "   | $($_.TrimEnd())" } }
$current = if ($DryRun) { '' } else { ((& wsl.exe -d $DistroName -u root -- cat /etc/wsl.conf 2>$null) -join "`n") }
if (-not $DryRun -and (Get-WslConfGaps $current).Count -eq 0) { Write-Output '   ok: already hardened' }
else {
  Invoke-InDistro "tr -d '\r' > /etc/wsl.conf && chmod 0644 /etc/wsl.conf" -Stdin $HardenedWslConf
  Invoke-Step "wsl.exe --terminate $DistroName (wsl.conf applies at the next start)" { & wsl.exe --terminate $DistroName }
}
if (-not $DryRun) {
  $pid1 = ''
  foreach ($i in 1..30) { $pid1 = ((& wsl.exe -d $DistroName -u root -- cat /proc/1/comm) -join '').Trim(); if ($pid1 -eq 'systemd') { break }; Start-Sleep 2 }
  if ($pid1 -ne 'systemd') { throw "systemd didn't start in $DistroName (PID 1 is '$pid1'); check wsl --version and /etc/wsl.conf" }
  Write-Output '   ok: systemd is PID 1'
}

# ------------------------------------------------------------------------------------------------ 4. the Linux setup

Write-Step "the engine's setup scripts, into $DistroName`:$SetupDir"
$share = "\\wsl$\$DistroName$($SetupDir -replace '/', '\')"
Invoke-Step "copy $EngineRoot\scripts and package.json to $share" {
  New-Item -ItemType Directory -Force -Path $share | Out-Null
  Copy-Item -Recurse -Force -Path (Join-Path $EngineRoot 'scripts') -Destination $share
  Copy-Item -Force -Path (Join-Path $EngineRoot 'package.json') -Destination $share
}
# Line endings from a Windows checkout, whatever git did with them.
Invoke-InDistro "find $SetupDir -type f -name '*.sh' -exec sed -i 's/\r`$//' {} + && chown -R root:root $SetupDir && chmod -R go-w $SetupDir"

Write-Step "the Linux hardened bootstrap, inside $DistroName"
$yes = if ($Yes) { ' --yes' } else { '' }
Invoke-InDistro "bash $SetupDir/scripts/bootstrap.sh --hardened$yes $Instance $Repo"

# ------------------------------------------------------------------------------------------------ 5. .wslconfig

$wslconfig = Join-Path $(if ($env:USERPROFILE) { $env:USERPROFILE } else { '~' }) '.wslconfig'
Write-Step "$wslconfig (the VM never idles out; 127.0.0.1 forwards to the distro)"
$before = if (Test-Path -LiteralPath $wslconfig) { Get-Content -Raw -LiteralPath $wslconfig } else { '' }
$after = Merge-IniText $before $WslConfigKeys
if ($before -eq $after) { Write-Output '   ok: already set' }
elseif ($DryRun) { Write-Output "   would set: $(($WslConfigKeys.wsl2.Keys | ForEach-Object { "[wsl2] $_=$($WslConfigKeys.wsl2[$_])" }) -join ', '), keeping the rest" }
else {
  if ($before -and -not (Test-Path -LiteralPath "$wslconfig.worklane-bak")) { Copy-Item -LiteralPath $wslconfig -Destination "$wslconfig.worklane-bak" }
  [System.IO.File]::WriteAllText($wslconfig, $after)
  Write-Output '   set (takes effect at the next wsl --shutdown or reboot)'
}

# ------------------------------------------------------------------------------------------------ 6. keep-alive

$spec = Get-KeepAliveSpec "$env:USERDOMAIN\$env:USERNAME"
Write-Step "scheduled task '$($spec.TaskName)': keeps $DistroName running, from boot"
Write-Output "   $($spec.Execute) $($spec.Arguments); triggers $($spec.Triggers -join ', '); restarts every minute if it stops"
if ($DryRun) { Write-Output "   would register scheduled task '$($spec.TaskName)' as $($spec.User) ($KeepAliveLogon logon), and start it" }
else {
  $action = New-ScheduledTaskAction -Execute $spec.Execute -Argument $spec.Arguments
  $triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User $spec.User))
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 9999 -RestartInterval (New-TimeSpan -Minutes 1)
  if ($KeepAliveLogon -eq 'Password') {
    $cred = Get-Credential -UserName $spec.User -Message "Your Windows password, for the keep-alive task to run at boot (Windows stores it, not Worklane)"
    Register-ScheduledTask -TaskName $spec.TaskName -Action $action -Trigger $triggers -Settings $settings -User $spec.User -Password $cred.GetNetworkCredential().Password -RunLevel Limited -Force | Out-Null
  } else {
    $principal = New-ScheduledTaskPrincipal -UserId $spec.User -LogonType S4U -RunLevel Limited
    Register-ScheduledTask -TaskName $spec.TaskName -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
  }
  Start-ScheduledTask -TaskName $spec.TaskName
  Write-Output '   registered and started'
}

# ------------------------------------------------------------------------------------------------ next

Write-Step 'next, by hand'
Write-Output "   1. Copy the App's private key into the distro: in Explorer, \\wsl$\$DistroName\root\ (or Get-Content key.pem | wsl -d $DistroName -u root -- sh -c 'cat > /root/app.pem')"
Write-Output "   2. wsl -d $DistroName -u root -- bash $SetupDir/scripts/setup/credentials.sh $Instance github-app <app-id> <installation-id> /root/app.pem $Repo"
Write-Output "   3. wsl -d $DistroName -u root -- bash $SetupDir/scripts/setup/credentials.sh $Instance claude"
Write-Output "   4. .\scripts\setup\windows\install.ps1 -Instance $Instance -Repo $Repo -AfterCredentials"
Write-Output "   the dashboard will be at http://127.0.0.1:$Port (forwarded from the distro); .\scripts\setup\windows\doctor.ps1 -Instance $Instance -Repo $Repo checks it all"
