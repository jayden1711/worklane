# Windows

Agents need a sandbox for Bash, and native Windows has none. So on a Windows machine there are two modes:

- **Native single-user:** the engine runs on Windows for the dashboard and Issues. Agents don't run, and `worklane doctor` says "Windows host, native single-user".
- **WSL2 hardened:** a dedicated WSL2 distro, `Worklane`, runs the Linux multi-user setup unchanged (`bootstrap.sh --hardened`). `worklane doctor` there says "Windows host, WSL2 hardened".

## What isolation hardened mode has

The isolation is Linux's own, inside the WSL VM: separate users for the coordinator and its agents, and the sandbox. WSL could add two openings on top of that, and the installer closes both in the distro's `/etc/wsl.conf`:

| Opening | Closed by |
|---|---|
| Windows drives mounted at `/mnt/c` …: an agent could read and write your Windows files | `[automount] enabled=false`, `mountFsTab=false` |
| Interop: a Linux process could start `cmd.exe` or `powershell.exe` as you | `[interop] enabled=false`, `appendWindowsPath=false` |

Two more settings go in the same file: `[boot] systemd=true` for the services, and `[user] default=root` because the setup makes its own users.

The Windows account that owns the distro is trusted. It can always enter the distro as root (`wsl -d Worklane -u root`), just as a Linux machine's admin can. Run the installer from your own account.

Repos live on WSL's own filesystem, never under `/mnt`. Instance checkouts go to `/srv/worklane/<name>/`. Both `worklane install` and `bootstrap.sh` refuse a checkout under `/mnt` or on a Windows drive, and doctor fails on one.

## What you run

The installer runs from an elevated PowerShell, in your own account, from a checkout of this repo. Read `scripts/setup/windows/install.ps1` first, then:

```powershell
.\scripts\setup\windows\install.ps1 -Instance <name> -Repo <owner/repo> -DryRun   # the whole plan; changes nothing
.\scripts\setup\windows\install.ps1 -Instance <name> -Repo <owner/repo>
```

It does these steps:

1. **WSL2:** installs WSL with `wsl.exe --install --no-distribution` if it's missing (restart Windows if it asks, then run the script again), then `wsl.exe --update`. WSL itself is Microsoft's component, installed through `wsl.exe`. The script needs version 2 or newer for systemd.
2. **The distro:** Ubuntu 24.04.5's WSL image, pinned by its sha256 from Ubuntu's `SHA256SUMS` (`lib.ps1`). It's imported as `Worklane` only if the file matches. Use `-DistroFile` for a copy you already downloaded; it's checked the same way.
3. **`/etc/wsl.conf`:** the hardened settings above. The distro then restarts, and the script waits until systemd is PID 1.
4. **The Linux setup:** this checkout's `scripts/` is copied to `/opt/worklane-setup` in the distro. Then `bootstrap.sh --hardened <name> <owner/repo>` runs there, showing each setup script for review (`-Yes` skips the review).
5. **`%USERPROFILE%\.wslconfig`:** sets `[wsl2] vmIdleTimeout=-1` so the VM doesn't idle out, and `localhostForwarding=true`. Your other settings are kept, and the old file is saved once as `.wslconfig.worklane-bak`.
6. **Keep-alive:** a scheduled task, "Worklane WSL keep-alive". It runs `wsl.exe -d Worklane --exec /bin/sleep infinity` at startup and at logon, and restarts it every minute if it stops. That keeps the distro, and the services in it, running. It uses an S4U logon, so no password is stored. If it can't start at boot on your machine, re-run with `-KeepAliveLogon Password`; Windows then stores your password.

After that, add the instance's credentials inside the distro. The installer prints the exact commands. The App's key goes in through `\\wsl$\Worklane\root\`, because the distro can't see your drives. Then finish with:

```powershell
.\scripts\setup\windows\install.ps1 -Instance <name> -Repo <owner/repo> -AfterCredentials
```

### The dashboard

Start it in a terminal with `wsl -d Worklane -u root -- bash /opt/worklane-setup/scripts/setup/dashboard.sh <name>`. It listens on the distro's `127.0.0.1:<port>`. WSL forwards that to Windows' `127.0.0.1:<port>`, so open the URL it prints in a Windows browser. Nothing is opened to your network.

### Checking it

Run `.\scripts\setup\windows\doctor.ps1 -Instance <name> -Repo <owner/repo>` from Windows. No admin is needed. It checks:

- the mode;
- the distro's `wsl.conf`, mounts, interop and systemd;
- the keep-alive task;
- `.wslconfig`;
- whether the dashboard's port reaches the distro.

Then it runs `worklane doctor` inside the distro as the coordinator. Inside the distro, `worklane doctor` reports the same isolation facts on its own.

## GPUs

In WSL2, an NVIDIA GPU doesn't appear as a PCI device. It comes through the Windows driver: `/dev/dxg`, plus `nvidia-smi` and `libcuda.so.1` under `/usr/lib/wsl/lib`. That directory isn't on a systemd service's PATH, so hardware detection looks there explicitly (`wslGpu()` in `src/os/windows/wsl.ts`). `worklane doctor` shows a `gpu` line when one is found.

## CI

GitHub-hosted Windows runners have no nested virtualization, so they can't run WSL2.

- **On `windows-latest`** (the `windows-host` job and the test matrix): the installer's dry run under Windows PowerShell 5.1 and PowerShell 7, the refusal of an image that doesn't match its pin, the scripts' parsing and helper functions, and single-user mode with both doctors.
- **`wsl2-isolation`:** runs the Windows doctor with `-Hardened`, and the in-distro probe (`isolation-check.sh`), on a self-hosted runner. It's off until you register a Windows runner with the labels `self-hosted`, `windows` and `wsl2`, with the Worklane distro and an instance set up on it, and set the repo variable `WSL2_RUNNER=true`. Set `WSL2_INSTANCE` too if the instance isn't called `ci`.
