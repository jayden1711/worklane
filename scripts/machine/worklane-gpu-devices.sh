#!/bin/bash
# The NVIDIA device nodes' owner, group and mode, installed root:root 0755 by scripts/setup/gpu-devices.sh as
# /usr/local/libexec/worklane-gpu-devices. udev runs it (/etc/udev/rules.d/99-worklane-gpu-devices.rules) on the same
# events as the driver package's own rule, after it; systemd runs it after nvidia-cdi-refresh.service (a drop-in's
# ExecStartPost=+) and as worklane-gpu-devices.service when that unit fails; root may run it by hand. No arguments,
# nothing read from anyone.
#
# Every /dev/nvidia* character device (nvidiactl, nvidia<N>, nvidia-uvm, nvidia-uvm-tools, nvidia-modeset, ...) becomes
# root:$GROUP 0660; each node under /dev/nvidia-caps and /dev/nvidia-caps-imex-channels becomes root:$GROUP with
# nothing for others (its own owner and group bits kept: MIG's config capability stays root's alone).
#
# WHY this exists, next to the driver's NVreg_DeviceFile* options (docs/test-runs.md "GPU devices"): Ubuntu's driver
# packages make the nodes with their own udev rule (71-nvidia.rules runs /sbin/ub-device-create on the driver's and
# nvidia_uvm's "add"), and that program sets every node it makes to root:root 0666, fixing any other mode back,
# whatever the driver's options say. This runs after it, on the same events. A root NVML call later (nvidia-smi, the
# nvidia-cdi-refresh unit at boot) puts nvidia-uvm, nvidia-uvm-tools and the nvidia-caps nodes back, so it runs again
# after that unit. NVreg_ModifyDeviceFiles=0 (gpu-devices.sh apply --no-dynamic-nodes) does not stop that reset
# (measured, #583: `sudo nvidia-smi -L` put nvidia-uvm and nvidia-uvm-tools back to root:root 0666 with it in effect):
# after any root NVML call, root runs this again, then gpu-devices.sh check.
set -uo pipefail
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
GROUP=worklane-gpu-dev
DEV=/dev
# No group (the setup was reverted, or never ran): nothing to do.
getent group "$GROUP" >/dev/null 2>&1 || exit 0
shopt -s nullglob
rc=0
for n in "$DEV"/nvidia* "$DEV"/nvidia-caps/* "$DEV"/nvidia-caps-imex-channels/*; do
  [ -c "$n" ] && [ ! -L "$n" ] || continue
  case "$n" in
    "$DEV"/nvidia-caps/* | "$DEV"/nvidia-caps-imex-channels/*) chown "root:$GROUP" -- "$n" && chmod o=,ug-xs -- "$n" || rc=1 ;;
    *) chown "root:$GROUP" -- "$n" && chmod 0660 -- "$n" || rc=1 ;;
  esac
done
exit "$rc"
