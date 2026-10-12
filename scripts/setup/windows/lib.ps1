# Shared by install.ps1 and doctor.ps1 (dot-sourced). Pure functions only: nothing here changes the machine,
# so tests call each one directly. Windows PowerShell 5.1 and PowerShell 7 both run it.
Set-StrictMode -Version 3

$Script:DistroName = 'Worklane'
$Script:KeepAliveTask = 'Worklane WSL keep-alive'
# Where the engine's setup scripts are copied inside the distro.
$Script:SetupDir = '/opt/worklane-setup'

# Everything the installer downloads, pinned. The sum is Ubuntu's own (releases.ubuntu.com/noble/SHA256SUMS); the
# file is refused unless it matches, before it's imported. A newer image is a reviewed change to these lines.
$Script:Pins = @{
  Distro = @{
    Name    = 'ubuntu-24.04.5-wsl-amd64.wsl'
    Urls    = @(
      'https://releases.ubuntu.com/noble/ubuntu-24.04.5-wsl-amd64.wsl',
      # Where Ubuntu moves a point release once a newer one ships.
      'https://old-releases.ubuntu.com/releases/noble/ubuntu-24.04.5-wsl-amd64.wsl'
    )
    Sha256  = 'bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e'
  }
}

# /etc/wsl.conf in the dedicated distro: systemd for the services; no Windows drives and no interop, so a process in
# the distro can neither touch the owner's Windows files nor start Windows programs as the owner. The engine's
# doctor checks the same keys (src/os/windows/wsl.ts, HARDENED_WSL_CONF).
$Script:HardenedWslConf = @'
# Written by Worklane's scripts/setup/windows/install.ps1. Changing it weakens the isolation the doctor reports.
[boot]
systemd=true

[automount]
enabled=false
mountFsTab=false

[interop]
enabled=false
appendWindowsPath=false

[user]
default=root
'@

# %USERPROFILE%\.wslconfig keys (the WSL VM, for every distro): never shut the VM down when idle, and forward
# Windows' 127.0.0.1 to services listening on the distro's localhost (the dashboard).
$Script:WslConfigKeys = [ordered]@{ wsl2 = [ordered]@{ vmIdleTimeout = '-1'; localhostForwarding = 'true' } }

function Test-InstanceName([string]$Name) { return $Name -cmatch '^[a-z][a-z0-9-]{0,20}$' }
function Test-RepoSlug([string]$Repo) { return $Repo -match '^[^/\s]+/[^/\s]+$' }

# The dashboard's port for an instance: the same as the engine's instancePort() (src/dashboard.ts).
function Get-InstancePort([string]$Name) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $b = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Name)) } finally { $sha.Dispose() }
  $u = [uint64]$b[0] * 16777216 + [uint64]$b[1] * 65536 + [uint64]$b[2] * 256 + [uint64]$b[3]
  return [int](4400 + ($u % 500))
}

# Refuse a file unless its sha256 is the pinned one; a mismatching download is deleted.
function Assert-PinnedFile([string]$Path, [string]$Sha256, [switch]$DeleteOnMismatch) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "no file at $Path" }
  $got = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($got -ne $Sha256.ToLowerInvariant()) {
    if ($DeleteOnMismatch) { Remove-Item -LiteralPath $Path -Force }
    throw "checksum mismatch for ${Path}: got $got, want $Sha256; nothing was imported"
  }
}

# Set keys in an INI text (.wslconfig), keeping everything else as it was: other keys, sections, comments.
function Merge-IniText([string]$Text, $Set) {
  $lines = [System.Collections.Generic.List[string]]::new()
  if ($Text) { foreach ($l in ($Text -split "\r?\n")) { $lines.Add($l) } }
  while ($lines.Count -gt 0 -and $lines[$lines.Count - 1] -eq '') { $lines.RemoveAt($lines.Count - 1) }
  foreach ($section in $Set.Keys) {
    $start = -1
    for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].Trim() -match "^\[\s*$([regex]::Escape($section))\s*\]$") { $start = $i; break } }
    if ($start -lt 0) {
      if ($lines.Count -gt 0) { $lines.Add('') }
      $lines.Add("[$section]")
      $start = $lines.Count - 1
    }
    foreach ($key in $Set[$section].Keys) {
      $value = $Set[$section][$key]
      $end = $lines.Count
      for ($i = $start + 1; $i -lt $lines.Count; $i++) { if ($lines[$i].Trim() -match '^\[') { $end = $i; break } }
      $found = $false
      for ($i = $start + 1; $i -lt $end; $i++) {
        if ($lines[$i] -match "^\s*$([regex]::Escape($key))\s*=") { $lines[$i] = "$key=$value"; $found = $true; break }
      }
      if (-not $found) {
        $at = $end
        while ($at -gt $start + 1 -and $lines[$at - 1].Trim() -eq '') { $at-- }
        $lines.Insert($at, "$key=$value")
      }
    }
  }
  return (($lines -join "`r`n") + "`r`n")
}

# INI text as section -> key -> value (lowercased names), like the engine's parseIni.
function ConvertFrom-IniText([string]$Text) {
  $out = @{}
  $section = ''
  foreach ($raw in ($Text -split "\r?\n")) {
    $line = $raw.Trim()
    if (-not $line -or $line.StartsWith('#') -or $line.StartsWith(';')) { continue }
    if ($line -match '^\[([^\]]+)\]$') { $section = $Matches[1].Trim().ToLowerInvariant(); if (-not $out.ContainsKey($section)) { $out[$section] = @{} }; continue }
    if ($section -and $line -match '^([^=]+)=(.*)$') { $out[$section][$Matches[1].Trim().ToLowerInvariant()] = ($Matches[2] -replace '\s+[#;].*$', '').Trim() }
  }
  return $out
}

# What a distro's /etc/wsl.conf leaves open, against the hardened keys. Empty: hardened.
function Get-WslConfGaps([string]$Text) {
  $have = ConvertFrom-IniText $Text
  $want = ConvertFrom-IniText $Script:HardenedWslConf
  $gaps = @()
  foreach ($s in $want.Keys) {
    foreach ($k in $want[$s].Keys) {
      $v = if ($have.ContainsKey($s) -and $have[$s].ContainsKey($k)) { $have[$s][$k] } else { '(unset)' }
      if ($v -ne $want[$s][$k]) { $gaps += "[$s] $k is $v, want $($want[$s][$k])" }
    }
  }
  return , $gaps
}

# `wsl.exe -l -v` (run with WSL_UTF8=1) as objects: Name, State, Version, Default.
function ConvertFrom-WslList([string]$Text) {
  $rows = @()
  foreach ($raw in (($Text -replace "`0", '') -split "\r?\n")) {
    $line = $raw.TrimEnd()
    if (-not $line.Trim() -or $line -match '^\s*\*?\s*NAME\s+STATE\s+VERSION') { continue }
    $default = $line.TrimStart().StartsWith('*')
    $f = ($line.TrimStart().TrimStart('*').Trim()) -split '\s+'
    if ($f.Count -ge 3) { $rows += [pscustomobject]@{ Name = $f[0]; State = $f[1]; Version = [int]$f[2]; Default = $default } }
  }
  # One row at a time down the pipeline (callers filter them with Where-Object, and wrap the result in @()).
  return $rows
}

# The keep-alive: a scheduled task that holds one process in the distro, so WSL never idles it out, from boot.
function Get-KeepAliveSpec([string]$User) {
  return [ordered]@{
    TaskName  = $Script:KeepAliveTask
    Execute   = "$(if ($env:WINDIR) { $env:WINDIR } else { 'C:\Windows' })\System32\wsl.exe"
    Arguments = "-d $Script:DistroName --exec /bin/sleep infinity"
    Triggers  = @('AtStartup', 'AtLogOn')
    User      = $User
    LogonType = 'S4U'
  }
}

# The instances' checkout root, from the distro's /etc/worklane/machine.json (scripts/setup/machine.sh); the default
# when it's missing or unreadable, like lib.sh's checkouts_root.
function Get-CheckoutsRoot([string]$MachineJson) {
  try { $c = ($MachineJson | ConvertFrom-Json).checkouts } catch { $c = $null }
  if ($c -is [string] -and $c -match '^/[A-Za-z0-9._/-]+$') { return $c }
  return '/srv/worklane'
}

# One line of the plan, or of the doctor's report.
function Write-Step([string]$What) { Write-Output ''; Write-Output "== $What" }
