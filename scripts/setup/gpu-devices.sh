#!/usr/bin/env bash
# As root, per machine with an NVIDIA GPU: who may open the GPU's device nodes at all (docs/test-runs.md "GPU devices").
#
#   sudo bash scripts/setup/gpu-devices.sh check                      read-only: the nodes, the driver's options, who
#                                                                     has a node open, the group; PASS or FAIL (exit 1)
#   sudo bash scripts/setup/gpu-devices.sh apply --users <you>[,<user>...] [--no-dynamic-nodes]
#   sudo bash scripts/setup/gpu-devices.sh revert
#
# By default every /dev/nvidia* node is root:root 0666: any local user (an agent user, a test user outside its sandbox,
# a coordinator) can use the GPU, outside the GPU lock (testrun-gpu.sh). apply makes them root:worklane-gpu-dev 0660
# from the next boot on, and the group exactly the users listed. Then reboot, and check again.
#
# WHY its own group, never worklane-gpu (the GPU locks' group): a granted test run gets this group for its own unit
# (the sandbox helper adds it), and must never be able to open a lock; and the owner's device access shouldn't hang on
# who may hold a lock.
#
# How the nodes get made, and what apply changes for each (the facts, measured on Ubuntu 24.04 with driver 595, are in
# docs/test-runs.md "GPU devices"):
#   - Ubuntu's driver packages' udev rule (71-nvidia.rules: /sbin/ub-device-create on the driver's and nvidia_uvm's
#     "add") makes the nodes root:root 0666: /etc/udev/rules.d/99-worklane-gpu-devices.rules runs
#     /usr/local/libexec/worklane-gpu-devices after it, on the same events.
#   - Any root process that starts NVML (nvidia-smi, and the nvidia-cdi-refresh.service the container toolkit runs at
#     boot) then puts nvidia-uvm and nvidia-uvm-tools back to root:root 0666 and the nvidia-caps nodes to root:root.
#     A drop-in on nvidia-cdi-refresh.service runs the fixer after it, and worklane-gpu-devices.service runs it when
#     that unit fails; the same unit runs at every boot after systemd-modules-load and nvidia-cdi-refresh, once udev
#     has settled, for a machine where that unit is absent or skipped, or whose late writer is something else (measured:
#     nvidia-uvm and nvidia-uvm-tools made after the last fixer run, with none after them).
#     apply --no-dynamic-nodes also sets NVreg_ModifyDeviceFiles=0, and /dev/nvidia-caps stays empty (MIG's
#     capability nodes aren't made: don't use it on a MIG GPU). That is all it does: it does NOT stop a root NVML call
#     resetting nvidia-uvm and nvidia-uvm-tools (measured, #583: with ModifyDeviceFiles: 0 in effect, `sudo nvidia-smi
#     -L` put both back to root:root 0666). After any root NVML call, run the fixer, then check.
#   - the driver's options (NVreg_DeviceFileUID, NVreg_DeviceFileGID, NVreg_DeviceFileMode) are what NVML applies to
#     nvidiactl, nvidia<N> and nvidia-modeset: /etc/modprobe.d/worklane-gpu-devices.conf sets them to 0, the group, 0660.
#   - nvidia-modprobe, where a distribution ships it, makes nvidia-uvm and nvidia-uvm-tools 0666 root:root whatever
#     the options say, and it is setuid root: any user could set them back. apply takes its setuid bit away
#     (dpkg-statoverride, so a package upgrade keeps it off); udev makes the nodes at boot, as root. Without it nothing
#     loads nvidia-uvm on demand for a user, so /etc/modules-load.d/worklane-gpu-devices.conf loads it at every boot.
#
# Never in the group: root (needs none), any harness user (wl-*: coordinators, test users, agent users) or a user an
# instance's agents or evals run as (instance.yaml run_as). nvidia-persistenced, the driver's own daemon user, is
# added when it exists. revert takes the files away and gives nvidia-modprobe, where there is one, its setuid bit back;
# the group stays.
source "$(dirname "$0")/lib.sh"

GROUP=worklane-gpu-dev
LOCK_GROUP=worklane-gpu
MODPROBE_FILE=/etc/modprobe.d/worklane-gpu-devices.conf
UDEV_RULE=/etc/udev/rules.d/99-worklane-gpu-devices.rules
FIXER=/usr/local/libexec/worklane-gpu-devices
FIXER_SRC="$(cd "$(dirname "$0")/../machine" && pwd)/worklane-gpu-devices.sh"
NV_PARAMS=/proc/driver/nvidia/params
DEV=/dev
# nvidia-uvm (CUDA needs it): loaded at boot from this file, since without a setuid nvidia-modprobe nothing loads it on
# demand. check reads whether it is loaded from $SYS_MODULE, and opens $UVM_NODE as a member.
MODULES_LOAD=/etc/modules-load.d/worklane-gpu-devices.conf
SYS_MODULE=/sys/module
UVM_NODE=/dev/nvidia-uvm
PERSISTENCED_USER=nvidia-persistenced
# WHY: a root NVML call (nvidia-smi; this unit, which the container toolkit runs at boot) resets nvidia-uvm to 0666
# after udev's fixer ran: a drop-in runs the fixer after the unit, and FIXER_UNIT_NAME when the unit fails (ExecStartPost
# never runs then).
CDI_UNIT=nvidia-cdi-refresh.service
CDI_DROPIN=/etc/systemd/system/nvidia-cdi-refresh.service.d/worklane-gpu-devices.conf
FIXER_UNIT_NAME=worklane-gpu-devices.service
FIXER_UNIT="/etc/systemd/system/$FIXER_UNIT_NAME"
# WHY: nvidia-persistenced's --user drop sets only its uid and gid, never the groups from /etc/group (measured: a member
# of the device group, it still fails to open the nodes); the groups systemd gives its root process before the drop stay.
PD_UNIT=nvidia-persistenced.service
PD_DROPIN=/etc/systemd/system/nvidia-persistenced.service.d/worklane-gpu-devices.conf
usage="usage: gpu-devices.sh check | apply --users <user>[,<user>...] [--no-dynamic-nodes] | revert"

cmd="${1:-}"
[ -n "$cmd" ] || { echo "$usage" >&2; exit 2; }
shift
users=""
static=""
case "$cmd" in
  check | revert) [ "$#" -eq 0 ] || { echo "$usage" >&2; exit 2; } ;;
  apply)
    [ "$#" -ge 2 ] && [ "$#" -le 3 ] && [ "$1" = --users ] || { echo "$usage" >&2; exit 2; }
    users="$2"
    if [ "$#" -eq 3 ]; then [ "$3" = --no-dynamic-nodes ] || { echo "$usage" >&2; exit 2; }; static=1; fi
    [[ "$users" =~ ^[a-z_][a-z0-9_-]{0,31}(,[a-z_][a-z0-9_-]{0,31}){0,15}$ ]] || { echo "--users: user names, comma-separated, got $users" >&2; exit 2; }
    ;;
  *) echo "$usage" >&2; exit 2 ;;
esac
as_root "$cmd" ${users:+--users "$users"} ${static:+--no-dynamic-nodes}

# Every NVIDIA character device node, one path a line.
nodes() {
  local n
  shopt -s nullglob
  for n in "$DEV"/nvidia* "$DEV"/nvidia-caps/* "$DEV"/nvidia-caps-imex-channels/*; do
    if [ -c "$n" ] && [ ! -L "$n" ]; then printf '%s\n' "$n"; fi
  done
  shopt -u nullglob
}
# Why a node isn't as it must be (root:$GROUP, nothing for others, no execute or set-id bit), or nothing.
node_problem() {
  local got o g m why=""
  got="$(stat -c '%U %G %a' -- "$1")"
  read -r o g m <<< "$got"
  if [ "$o" != root ] || [ "$g" != "$GROUP" ]; then why="$o:$g, not root:$GROUP"
  elif (( (8#$m & 8#7117) != 0 )); then why="mode $m: more than 0660"; fi
  [ -z "$why" ] && return 0
  # WHY: a root NVML call (nvidia-smi, $CDI_UNIT) resets these two to root:root 0666 whenever it runs.
  case "$1" in "$DEV"/nvidia-uvm*) why="$why (a root NVML call such as nvidia-smi puts it back: run $FIXER)" ;; esac
  echo "$why"
}
# The setuid-root nvidia-modprobe, if there is one.
setuid_modprobe() {
  local p
  p="$(command -v nvidia-modprobe 2>/dev/null)" || return 1
  p="$(readlink -f -- "$p")"
  [ -f "$p" ] && [ -u "$p" ] && [ "$(stat -c %u -- "$p")" = 0 ] && printf '%s\n' "$p"
}
# Whether the running kernel's initramfs has the nvidia module (0 yes, 1 no, 2 can't tell).
nvidia_in_initramfs() {
  local img="/boot/initrd.img-$(uname -r)"
  command -v lsinitramfs >/dev/null 2>&1 && [ -f "$img" ] || return 2
  lsinitramfs "$img" 2>/dev/null | grep -Eq '/nvidia\.ko(\.(zst|xz|gz))?$'
}
# The group's gid, or nothing.
group_gid() { { getent group "$GROUP" 2>/dev/null || true; } | cut -d: -f3; }
members() { { getent group "$GROUP" 2>/dev/null || true; } | cut -d: -f4; }
# Why <user> may not be in the device group, or nothing.
member_refusal() {
  local u="$1" uid
  uid="$(id -u "$u" 2>/dev/null)" || { echo "no user $u"; return 0; }
  [ "$uid" != 0 ] || { echo "$u is root, which needs no group"; return 0; }
  [[ "$u" != wl-* ]] || { echo "$u is a harness user (wl-*): coordinators, test users and agent users never open the GPU outside a granted test run"; return 0; }
  if run_as_users | grep -qxF -- "$u"; then echo "$u is a user an instance's agents or evals run as (instance.yaml run_as)"; return 0; fi
  return 0
}

check() {
  local n p fails=() m pid u comm open seen gid v name val mp r mem out
  say "the NVIDIA device nodes (each must be root:$GROUP, 0660 or stricter)"
  local any=0
  while IFS= read -r n; do
    any=1
    p="$(node_problem "$n")"
    printf '  %s %s  %s\n' "$(stat -c '%a %U:%G' -- "$n")" "$n" "${p:-ok}"
    [ -z "$p" ] || fails+=("$n is $p")
  done < <(nodes)
  [ "$any" = 1 ] || echo "  none (no NVIDIA driver loaded, or no GPU)"

  say "the driver's device file options in effect ($NV_PARAMS)"
  gid="$(group_gid)"
  if [ -r "$NV_PARAMS" ]; then
    for name in DeviceFileUID DeviceFileGID DeviceFileMode ModifyDeviceFiles; do
      val="$(sed -n "s/^$name: *//p" "$NV_PARAMS" | head -n 1)"
      if [ "$name" = DeviceFileMode ] && [ -n "$val" ]; then printf '  %s: %s (octal %o)\n' "$name" "$val" "$val"; else echo "  $name: ${val:-(not reported)}"; fi
      case "$name" in
        DeviceFileUID) [ "$val" = 0 ] || fails+=("the driver's DeviceFileUID is ${val:-unknown}, not 0") ;;
        DeviceFileGID) [ -n "$gid" ] && [ "$val" = "$gid" ] || fails+=("the driver's DeviceFileGID is ${val:-unknown}, not $GROUP's gid (${gid:-no group}): reboot after apply") ;;
        ModifyDeviceFiles) if grep -qs 'NVreg_ModifyDeviceFiles=0' "$MODPROBE_FILE" && [ "$val" != 0 ]; then fails+=("the driver's ModifyDeviceFiles is ${val:-unknown}, not 0 as $MODPROBE_FILE asks: reboot after apply"); fi ;;
        DeviceFileMode) [[ "$val" =~ ^[0-9]+$ ]] && (( (val & 8#7117) == 0 )) || fails+=("the driver's DeviceFileMode is ${val:-unknown} (octal $(printf '%o' "${val:-0}")), more than 0660: reboot after apply") ;;
      esac
    done
  else
    echo "  none: the nvidia module isn't loaded"
  fi

  say "what sets them at boot"
  if [ -f "$MODPROBE_FILE" ]; then echo "  $MODPROBE_FILE:"; sed 's/^/    /' "$MODPROBE_FILE"; else echo "  no $MODPROBE_FILE"; fi
  mp="$(grep -lE 'NVreg_(DeviceFile|ModifyDeviceFiles)' /etc/modprobe.d/*.conf /lib/modprobe.d/*.conf /usr/lib/modprobe.d/*.conf 2>/dev/null | grep -vxF "$MODPROBE_FILE" || true)"
  if [ -n "$mp" ]; then echo "  other files setting the same options (they would fight this one):"; printf '    %s\n' $mp; fails+=("another modprobe.d file sets the device file options: $(echo $mp)"); fi
  if [ -f "$UDEV_RULE" ]; then echo "  $UDEV_RULE: present (runs $FIXER after the driver package's rule)"; else echo "  no $UDEV_RULE"; fi
  [ ! -f "$UDEV_RULE" ] || [ -x "$FIXER" ] || fails+=("$UDEV_RULE runs $FIXER, which isn't installed: run apply again")
  v="$(grep -lE 'ub-device-create|create-uvm-dev-node|nvidia-modprobe' /lib/udev/rules.d/*.rules /usr/lib/udev/rules.d/*.rules /etc/udev/rules.d/*.rules 2>/dev/null | grep -vxF "$UDEV_RULE" || true)"
  if [ -n "$v" ]; then echo "  the driver's own udev rules that make the nodes (0666; the rule above runs after them):"; printf '    %s\n' $v; fi
  if p="$(setuid_modprobe)"; then
    echo "  $p: setuid root: any user can run it to make nvidia-uvm and nvidia-uvm-tools 0666 again"
    fails+=("$p is setuid root (any user can reset nvidia-uvm to 0666): run apply")
  elif p="$(command -v nvidia-modprobe 2>/dev/null)"; then echo "  $p: not setuid ($(stat -c '%a %U' -- "$(readlink -f -- "$p")"))"
  else echo "  no nvidia-modprobe"
  fi
  say "what runs the fixer at boot, once udev has settled ($FIXER_UNIT_NAME)"
  if boot_unit_ok; then echo "  $FIXER_UNIT_NAME: enabled; after systemd-modules-load and $CDI_UNIT"
  else
    echo "  $FIXER_UNIT_NAME is missing, wrong or not enabled"
    fails+=("nothing runs the fixer once udev and the NVIDIA services have settled at boot (a node made after udev's own run stays root:root): run apply")
  fi
  say "what puts the nodes back after udev set them (a root NVML call: nvidia-smi, $CDI_UNIT at boot)"
  if cdi_unit_exists; then
    if dropin_ok; then echo "  $CDI_DROPIN: runs $FIXER after $CDI_UNIT, and $FIXER_UNIT_NAME when it fails"
    else
      echo "  $CDI_UNIT has no (or a wrong) $CDI_DROPIN, or $FIXER_UNIT is missing"
      fails+=("$CDI_UNIT runs a root NVML call that puts nvidia-uvm back to root:root 0666, and nothing runs the fixer after it: run apply")
    fi
  else echo "  no $CDI_UNIT on this machine: a root nvidia-smi still puts nvidia-uvm back to 0666 (run $FIXER)"; fi
  say "$PD_UNIT (the driver's persistence daemon, as $PERSISTENCED_USER)"
  if pd_applies; then
    if pd_dropin_ok; then echo "  $PD_DROPIN: gives it $GROUP"
    elif [ "$(systemctl is-enabled "$PD_UNIT" 2>/dev/null)" = masked ]; then echo "  masked: it doesn't run"
    else
      echo "  no (or an unloaded) $PD_DROPIN: it runs as $PERSISTENCED_USER without $GROUP"
      fails+=("$PD_UNIT can't open the nodes: its --user drop loses the device group even for a member: run apply")
    fi
  else echo "  no $PD_UNIT or no user $PERSISTENCED_USER here: nothing to give the group to"; fi
  r=0; nvidia_in_initramfs || r=$?; case "$r" in 0) echo "  the initramfs has the nvidia module (apply and revert update it)" ;; 1) echo "  the initramfs has no nvidia module" ;; *) echo "  the initramfs: can't tell (no lsinitramfs or image)" ;; esac

  say "who has an NVIDIA node open now (each would need the group, or loses the GPU at its next open)"
  seen=""
  for p in /proc/[0-9]*; do
    open="$(find "$p/fd" -maxdepth 1 -type l -lname "$DEV/nvidia*" -printf '%l\n' 2>/dev/null | sort -u | tr '\n' ' ' || true)"
    [ -n "$open" ] || continue
    pid="${p#/proc/}"
    u="$(stat -c %U -- "$p" 2>/dev/null)" || continue
    comm="$(cat "$p/comm" 2>/dev/null || echo '?')"
    echo "  pid $pid  $u  $comm  $open"
    seen=1
  done
  [ -n "$seen" ] || echo "  nobody"

  say "nvidia-uvm (CUDA needs it; loaded at boot by $MODULES_LOAD, never on demand)"
  if [ "$any" = 1 ] || [ -d "$SYS_MODULE/nvidia" ]; then
    if [ -d "$SYS_MODULE/nvidia_uvm" ]; then echo "  the nvidia_uvm module: loaded"; else
      echo "  the nvidia_uvm module: NOT loaded"
      fails+=("the nvidia_uvm module isn't loaded ($MODULES_LOAD loads it at boot: run apply, then reboot)")
    fi
    if [ -f "$MODULES_LOAD" ]; then echo "  $MODULES_LOAD: present"; else echo "  no $MODULES_LOAD"; fi
    # Opened as a member, the way a granted user opens it (check runs as root, which opens anything): the first member
    # that is a person's login (uid 1000 or more).
    mem=""
    for u in $(members | tr ',' ' '); do
      if [ "$(id -u "$u" 2>/dev/null || echo 0)" -ge 1000 ]; then mem="$u"; break; fi
    done
    if [ -z "$mem" ]; then
      echo "  opening $UVM_NODE as a member: skipped, $GROUP has no member that is a person's login (uid 1000 or more)"
    elif [ ! -c "$UVM_NODE" ]; then
      echo "  no $UVM_NODE"
      fails+=("no $UVM_NODE to open")
    elif out="$(cd / && runuser -u "$mem" -- sh -c 'exec 3<>"$1"' _ "$UVM_NODE" 2>&1)"; then
      echo "  $mem (a member) opens $UVM_NODE: ok"
    else
      echo "  $mem (a member) can't open $UVM_NODE: $out"
      fails+=("$mem, a member of $GROUP, can't open $UVM_NODE: ${out:-no reason given}")
    fi
  else
    echo "  no NVIDIA driver loaded: nothing to check"
  fi

  say "the $GROUP group"
  if [ -z "$gid" ]; then
    echo "  none (apply makes it)"
    [ "$any" = 0 ] || fails+=("no $GROUP group")
  else
    m="$(members)"
    echo "  gid $gid, members: ${m:-none}"
    for u in ${m//,/ }; do
      p="$(member_refusal "$u")"
      [ -z "$p" ] || { echo "  $u must not be a member: $p"; fails+=("$u is in $GROUP: $p"); }
    done
    if id -u "$PERSISTENCED_USER" >/dev/null 2>&1 && [[ ",$m," != *",$PERSISTENCED_USER,"* ]]; then
      echo "  $PERSISTENCED_USER (the driver's daemon) is not a member: apply adds it"
    fi
  fi

  echo
  if [ "${#fails[@]}" -eq 0 ]; then
    if [ "$any" = 0 ]; then echo "PASS: no NVIDIA device node on this machine"; else echo "PASS: every NVIDIA device node is root:$GROUP, 0660 or stricter; nobody else can open one"; fi
    return 0
  fi
  echo "FAIL: ${#fails[@]} problem(s):"
  printf '  - %s\n' "${fails[@]}"
  return 1
}

# The modprobe options file for this gid, as apply writes it.
modprobe_text() {
  printf '# Written by scripts/setup/gpu-devices.sh: NVIDIA device nodes root:%s 0660 (docs/test-runs.md "GPU devices").\n' "$GROUP"
  printf 'options nvidia NVreg_DeviceFileUID=0 NVreg_DeviceFileGID=%s NVreg_DeviceFileMode=0660%s\n' "$1" "${static:+ NVreg_ModifyDeviceFiles=0}"
}
udev_text() {
  printf '# Written by scripts/setup/gpu-devices.sh (docs/test-runs.md "GPU devices"): after the driver package'"'"'s own rule\n'
  printf '# (71-nvidia.rules, which makes the nodes root:root 0666), on the same events, the nodes become root:%s 0660.\n' "$GROUP"
  printf 'ACTION=="add", DEVPATH=="/bus/pci/drivers/nvidia", RUN+="%s"\n' "$FIXER"
  printf 'ACTION=="add", SUBSYSTEM=="module", DEVPATH=="/module/nvidia", RUN+="%s"\n' "$FIXER"
  printf 'ACTION=="add", SUBSYSTEM=="module", DEVPATH=="/module/nvidia_uvm", RUN+="%s"\n' "$FIXER"
  printf 'ACTION=="add", SUBSYSTEM=="module", DEVPATH=="/module/nvidia_modeset", RUN+="%s"\n' "$FIXER"
}
cdi_unit_exists() { systemctl cat "$CDI_UNIT" >/dev/null 2>&1; }
# The persistence daemon's unit and user both exist (a machine without either has nothing to give the group to).
pd_applies() { systemctl cat "$PD_UNIT" >/dev/null 2>&1 && id -u "$PERSISTENCED_USER" >/dev/null 2>&1; }
pd_dropin_text() {
  printf '# Written by scripts/setup/gpu-devices.sh (docs/test-runs.md "GPU devices"): the daemon opens the nodes as its own user, outside the group list.\n'
  printf '[Service]\nSupplementaryGroups=%s\n' "$GROUP"
}
# Whether systemd has loaded the group into the unit (a drop-in not yet daemon-reloaded doesn't count).
pd_dropin_ok() {
  [ -f "$PD_DROPIN" ] && grep -qx "SupplementaryGroups=$GROUP" "$PD_DROPIN" && [[ " $(systemctl show "$PD_UNIT" -p SupplementaryGroups --value 2>/dev/null) " == *" $GROUP "* ]]
}
# The drop-in's text. INVARIANT: ExecStartPost carries the + prefix: it runs with full privileges, outside this unit's
# CapabilityBoundingSet (no CAP_CHOWN there, so the fixer couldn't set the group).
dropin_text() {
  printf '# Written by scripts/setup/gpu-devices.sh (docs/test-runs.md "GPU devices"): the nodes back to root:%s after this unit.\n' "$GROUP"
  printf '[Unit]\nOnFailure=%s\n[Service]\nExecStartPost=+%s\n' "$FIXER_UNIT_NAME" "$FIXER"
}
fixer_unit_text() {
  printf '# Written by scripts/setup/gpu-devices.sh: every boot, after udev has settled, and when %s fails (its ExecStartPost never ran).\n' "$CDI_UNIT"
  printf '[Unit]\nDescription=The NVIDIA device nodes back to root:%s\nAfter=systemd-modules-load.service %s\n' "$GROUP" "$CDI_UNIT"
  printf '[Service]\nType=oneshot\nExecStart=-/usr/bin/udevadm settle --timeout=30\nExecStart=%s\n[Install]\nWantedBy=multi-user.target\n' "$FIXER"
}
# The boot unit is in place and enabled (whether or not the NVIDIA container toolkit's unit exists).
boot_unit_ok() {
  [ -f "$FIXER_UNIT" ] && grep -qx "ExecStart=$FIXER" "$FIXER_UNIT" && grep -qx 'WantedBy=multi-user.target' "$FIXER_UNIT" \
    && [ "$(systemctl is-enabled "$FIXER_UNIT_NAME" 2>/dev/null)" = enabled ]
}
dropin_ok() {
  [ -f "$CDI_DROPIN" ] && [ -f "$FIXER_UNIT" ] && grep -qx "ExecStartPost=+$FIXER" "$CDI_DROPIN" && grep -qx "OnFailure=$FIXER_UNIT_NAME" "$CDI_DROPIN" && grep -qx "ExecStart=$FIXER" "$FIXER_UNIT"
}
# Rebuild the initramfs when it carries the nvidia module (its modprobe options go in with it).
initramfs_update() {
  local r=0
  nvidia_in_initramfs || r=$?
  case "$r" in
    0) say "the initramfs has the nvidia module: updating it"; update-initramfs -u ;;
    1) echo "the initramfs has no nvidia module: nothing to update" ;;
    *) echo "can't tell whether the initramfs has the nvidia module (no lsinitramfs or /boot/initrd.img-$(uname -r)); if it does: sudo update-initramfs -u" ;;
  esac
}

apply() {
  local u why list=() gid tmp p
  for u in ${users//,/ }; do
    why="$(member_refusal "$u")"
    [ -z "$why" ] || { echo "refused: $why" >&2; exit 1; }
    [[ " ${list[*]-} " == *" $u "* ]] || list+=("$u")
  done
  if id -u "$PERSISTENCED_USER" >/dev/null 2>&1 && [[ " ${list[*]} " != *" $PERSISTENCED_USER "* ]]; then
    list+=("$PERSISTENCED_USER")
    echo "adding $PERSISTENCED_USER too: the driver's persistence daemon opens the nodes as that user"
  fi
  [ -f "$FIXER_SRC" ] || { echo "no $FIXER_SRC next to this script" >&2; exit 1; }
  p="$(grep -lE 'NVreg_(DeviceFile|ModifyDeviceFiles)' /etc/modprobe.d/*.conf /lib/modprobe.d/*.conf /usr/lib/modprobe.d/*.conf 2>/dev/null | grep -vxF "$MODPROBE_FILE" || true)"
  [ -z "$p" ] || { echo "refused: another modprobe.d file sets the driver's device file options ($(echo $p)); remove those lines first" >&2; exit 1; }

  say "the $GROUP group: exactly ${list[*]}"
  groupadd -f -r "$GROUP"
  gid="$(group_gid)"
  [[ "$gid" =~ ^[0-9]+$ ]] || { echo "can't read $GROUP's gid" >&2; exit 1; }
  [ "$gid" != "$({ getent group "$LOCK_GROUP" 2>/dev/null || true; } | cut -d: -f3)" ] || { echo "$GROUP has $LOCK_GROUP's gid: refusing" >&2; exit 1; }
  gpasswd -M "$(IFS=,; echo "${list[*]}")" "$GROUP" >/dev/null
  echo "members: $(members)"

  say "$FIXER (run by udev)"
  bash -n "$FIXER_SRC" || { echo "$FIXER_SRC doesn't parse; nothing installed" >&2; exit 1; }
  install -d -o root -g root -m 0755 "$(dirname "$FIXER")"
  put_file root root 0755 "$FIXER" < "$FIXER_SRC"
  echo "installed $FIXER"

  say "$MODPROBE_FILE"
  tmp="$(dirname "$MODPROBE_FILE")/.$(basename "$MODPROBE_FILE").tmp"
  rm -f "$tmp"
  install -o root -g root -m 0644 /dev/null "$tmp"
  modprobe_text "$gid" > "$tmp"
  grep -qx "options nvidia NVreg_DeviceFileUID=0 NVreg_DeviceFileGID=$gid NVreg_DeviceFileMode=0660${static:+ NVreg_ModifyDeviceFiles=0}" "$tmp" || { rm -f "$tmp"; echo "the options file came out wrong; nothing installed" >&2; exit 1; }
  mv -f "$tmp" "$MODPROBE_FILE"
  sed 's/^/  /' "$MODPROBE_FILE"

  say "$MODULES_LOAD"
  install -d -o root -g root -m 0755 "$(dirname "$MODULES_LOAD")"
  tmp="$(dirname "$MODULES_LOAD")/.$(basename "$MODULES_LOAD").tmp"
  rm -f "$tmp"
  install -o root -g root -m 0644 /dev/null "$tmp"
  printf '# Written by scripts/setup/gpu-devices.sh: nvidia-uvm at every boot (nothing loads it on demand for a user without a setuid nvidia-modprobe).\nnvidia-uvm\n' > "$tmp"
  grep -qx 'nvidia-uvm' "$tmp" || { rm -f "$tmp"; echo "the modules-load file came out wrong; nothing installed" >&2; exit 1; }
  mv -f "$tmp" "$MODULES_LOAD"
  echo "installed $MODULES_LOAD (systemd-modules-load reads only *.conf, so the temp was never live)"

  say "$UDEV_RULE"
  install -d -o root -g root -m 0755 "$(dirname "$UDEV_RULE")"
  tmp="$(dirname "$UDEV_RULE")/.$(basename "$UDEV_RULE").tmp"
  rm -f "$tmp"
  install -o root -g root -m 0644 /dev/null "$tmp"
  udev_text > "$tmp"
  # udevadm verify (systemd 254 and later) checks the rule's syntax, on a copy under its own name in a private
  # directory; udev reads only *.rules, so the dotted temp is never live.
  if udevadm verify --help >/dev/null 2>&1; then
    local style=() vd ok=0
    if udevadm verify --help 2>/dev/null | grep -q -- --no-style; then style=(--no-style); fi
    vd="$(mktemp -d)"
    cp -- "$tmp" "$vd/$(basename "$UDEV_RULE")"
    udevadm verify ${style[@]+"${style[@]}"} "$vd/$(basename "$UDEV_RULE")" || ok=1
    rm -rf -- "$vd"
    [ "$ok" = 0 ] || { rm -f "$tmp"; echo "udevadm verify refused the rule; nothing installed" >&2; exit 1; }
  fi
  mv -f "$tmp" "$UDEV_RULE"
  udevadm control --reload 2>/dev/null || true
  echo "installed $UDEV_RULE"

  if pd_applies; then
    say "$PD_DROPIN"
    install -d -o root -g root -m 0755 "$(dirname "$PD_DROPIN")"
    tmp="$(dirname "$PD_DROPIN")/.$(basename "$PD_DROPIN").tmp"
    rm -f "$tmp"
    install -o root -g root -m 0644 /dev/null "$tmp"
    pd_dropin_text > "$tmp"
    grep -qx "SupplementaryGroups=$GROUP" "$tmp" || { rm -f "$tmp"; echo "the drop-in came out wrong; nothing installed" >&2; exit 1; }
    mv -f "$tmp" "$PD_DROPIN"
    systemctl daemon-reload
    echo "installed: $PD_UNIT runs with $GROUP from the next start (reboot, or: systemctl restart $PD_UNIT)"
  fi

  say "$FIXER_UNIT (every boot, once udev has settled; and when $CDI_UNIT fails)"
  tmp="$(dirname "$FIXER_UNIT")/.$(basename "$FIXER_UNIT").tmp"
  rm -f "$tmp"
  install -o root -g root -m 0644 /dev/null "$tmp"
  fixer_unit_text > "$tmp"
  mv -f "$tmp" "$FIXER_UNIT"
  systemctl daemon-reload
  systemctl enable "$FIXER_UNIT_NAME" >/dev/null
  boot_unit_ok || { echo "the boot unit came out wrong or didn't enable" >&2; exit 1; }
  echo "installed and enabled $FIXER_UNIT_NAME"

  if cdi_unit_exists; then
    say "$CDI_DROPIN"
    install -d -o root -g root -m 0755 "$(dirname "$CDI_DROPIN")"
    tmp="$(dirname "$CDI_DROPIN")/.$(basename "$CDI_DROPIN").tmp"
    rm -f "$tmp"
    install -o root -g root -m 0644 /dev/null "$tmp"
    dropin_text > "$tmp"
    mv -f "$tmp" "$CDI_DROPIN"
    systemctl daemon-reload
    dropin_ok || { echo "the drop-in came out wrong" >&2; exit 1; }
    echo "installed: the fixer runs after $CDI_UNIT, and as $FIXER_UNIT_NAME when it fails"
  else
    echo "no $CDI_UNIT here: only $FIXER_UNIT_NAME runs the fixer, at boot. A root nvidia-smi later still puts nvidia-uvm back to 0666, with --no-dynamic-nodes too: run $FIXER after it, then check."
  fi

  if p="$(setuid_modprobe)"; then
    say "$p: its setuid bit off"
    if command -v dpkg-statoverride >/dev/null 2>&1 && dpkg -S "$p" >/dev/null 2>&1; then
      dpkg-statoverride --list "$p" >/dev/null 2>&1 && dpkg-statoverride --remove "$p" >/dev/null
      dpkg-statoverride --update --add root root 0755 "$p"
      echo "dpkg-statoverride: $p root root 0755 (kept through package upgrades; revert undoes it)"
    else
      chmod u-s -- "$p"
      echo "chmod u-s $p (not dpkg's: a reinstall may set it again, and check then says FAIL)"
    fi
  fi

  initramfs_update
  cat <<EOF

Done; nothing changes on the running system until the driver loads again. Next:
  1. Reboot (recommended): sudo reboot
     (Reloading the driver instead means stopping everything that uses the GPU, the display manager and
     nvidia-persistenced included, then rmmod and modprobe of nvidia_uvm, nvidia_drm, nvidia_modeset and nvidia. An
     rmmod while anything holds the GPU fails or can hang the machine: don't, unless you must.)
  2. Then: sudo bash $0 check   (must say PASS, with the nvidia_uvm module loaded and a member opening $UVM_NODE)
  3. id <your user>   (must list $GROUP; a session from before step 1 doesn't have it: log in again)
EOF
}

revert() {
  local p
  say "removing $MODPROBE_FILE, $MODULES_LOAD, $UDEV_RULE, $CDI_DROPIN, $PD_DROPIN, $FIXER_UNIT and $FIXER"
  systemctl disable "$FIXER_UNIT_NAME" >/dev/null 2>&1 || true
  rm -f -- "$MODPROBE_FILE" "$MODULES_LOAD" "$UDEV_RULE" "$CDI_DROPIN" "$PD_DROPIN" "$FIXER_UNIT" "$FIXER"
  rmdir "$(dirname "$CDI_DROPIN")" "$(dirname "$PD_DROPIN")" 2>/dev/null || true
  systemctl daemon-reload 2>/dev/null || true
  udevadm control --reload 2>/dev/null || true
  p="$(command -v nvidia-modprobe 2>/dev/null || true)"
  if [ -n "$p" ]; then
    p="$(readlink -f -- "$p")"
    if command -v dpkg-statoverride >/dev/null 2>&1 && [ "$(dpkg-statoverride --list "$p" 2>/dev/null)" = "root root 0755 $p" ]; then
      dpkg-statoverride --remove "$p" >/dev/null
      chmod 4755 -- "$p"
      echo "$p: setuid root again, as its package ships it"
    fi
  fi
  initramfs_update
  echo "The $GROUP group stays (members: $(m="$(members)"; echo "${m:-none}")); remove it by hand if you want: sudo groupdel $GROUP"
  echo "The nodes keep their modes until the driver loads again (reboot): then they're root:root 0666, open to every local user."
}

case "$cmd" in
  check) check ;;
  apply) apply ;;
  revert) revert ;;
esac
