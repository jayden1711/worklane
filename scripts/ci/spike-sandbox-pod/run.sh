#!/usr/bin/env bash
# SPIKE (do not merge), #698 decision 5: can Claude Code's command sandbox (bubblewrap, through Anthropic's
# sandbox-runtime) start inside a locked-down Kubernetes pod? CI only (.github/workflows/spike-sandbox-pod.yml), on a
# throwaway GitHub-hosted runner; it needs docker and sudo. No model is called.
# CLUSTER=kind: a kind cluster (the node is a docker container). CLUSTER=k3s: k3s straight on the runner, so pods run
# on a real node, with the host's AppArmor and no nesting (kind's node can't start hostUsers: false pods: sysfs).
#   run.sh host                 the runner's kernel, the AppArmor userns sysctl, docker, containerd and runc
#   run.sh cluster              the cluster (pinned versions), the probe image, the namespaces, the Localhost seccomp
#                               profile, and the node's own containerd/runc/kubelet facts
#   run.sh gvisor               gVisor as RuntimeClass "gvisor" (best effort: on failure the profile is skipped)
#   run.sh probe <pass>         every profile in pods.mjs, one pod each; logs under $OUT/<pass>/
#   run.sh table                the results table (also to the job summary)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
OUT="${OUT:-$RUNNER_TEMP/spike-sandbox-pod}"
CLUSTER="${CLUSTER:-kind}"
NAME=spike-sbx
NODE="$NAME-control-plane"
KIND_VERSION=v0.33.0
KIND_SHA256=aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d
NODE_IMAGE='kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5'
K3S_VERSION='v1.37.1+k3s1'
K3S_SHA256=92b94582eb7b34a8cf532e6006842b9ed215a6783cf56a3dd6271fd35243b2c0
GVISOR_RELEASE=20260928
GVISOR_SHA512=c8d3a9fd4d4c4f5b8ff213caa4517356be128d18659ec4cde37828fe797f61a9725a602a846c81a8ed19c057a996515d31c081eba343ed4613a89951ba32ed59
# Docker's default seccomp profile (github.com/moby/profiles, tag seccomp/v0.2.4), the base of the Localhost profile.
MOBY_PROFILES_COMMIT=245180c51918481c0525424b3ee025d2b435d46c
MOBY_SECCOMP_SHA256=785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334
K3S_CONTAINERD=/var/lib/rancher/k3s/agent/etc/containerd
mkdir -p "$OUT"

# kubectl, a shell on the node, and a file copied onto the node, for either cluster. kind's node image ships kubectl,
# and k3s is its own kubectl, so there's no kubectl download to pin.
k() {
  if [ "$CLUSTER" = kind ]; then docker exec -i "$NODE" kubectl --kubeconfig /etc/kubernetes/admin.conf "$@"; else sudo k3s kubectl "$@"; fi
}
node_sh() {
  if [ "$CLUSTER" = kind ]; then docker exec "$NODE" sh -c "$1" < /dev/null; else sudo sh -c "$1" < /dev/null; fi
}
node_cp() { # <local file or dir> <node path>
  if [ "$CLUSTER" = kind ]; then docker cp "$1" "$NODE:$2"; else sudo cp -a "$1" "$2"; fi
}

host() {
  echo "kernel: $(uname -r) ($(uname -m))"
  grep PRETTY_NAME /etc/os-release
  echo "kernel.apparmor_restrict_unprivileged_userns: $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>&1)"
  echo "kernel.unprivileged_userns_clone: $(sysctl -n kernel.unprivileged_userns_clone 2>&1)"
  echo "user.max_user_namespaces: $(sysctl -n user.max_user_namespaces 2>&1)"
  echo "AppArmor enabled: $(cat /sys/module/apparmor/parameters/enabled 2>&1)"
  docker version --format 'docker server {{.Server.Version}}'
  docker info --format 'docker default runtime {{.DefaultRuntime}}; security {{json .SecurityOptions}}'
  echo "host containerd: $(containerd --version 2>&1 || true)"
  echo "host runc: $(runc --version 2>&1 | tr '\n' ' ' || true)"
}

wait_ready() {
  for _ in $(seq 90); do k get nodes < /dev/null 2> /dev/null | grep -q ' Ready ' && return 0; sleep 2; done
  k get nodes < /dev/null || true
  return 1
}

cluster() {
  local bin="$OUT/bin" img="$OUT/image"
  mkdir -p "$bin" "$img/srt"

  # The probe image: sandbox-runtime from this repo's lockfile (a runtime dependency already: no new package).
  cp "$repo/package.json" "$repo/package-lock.json" "$img/srt/"
  (cd "$img/srt" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  cp "$here/Dockerfile" "$here/probe.sh" "$here/wrap.mjs" "$img/"
  docker build -t spike-probe:1 "$img"
  docker run --rm --entrypoint sh spike-probe:1 -c 'dpkg-query -W bubblewrap socat ripgrep util-linux; node --version; /opt/srt/node_modules/.bin/srt --version'

  if [ "$CLUSTER" = kind ]; then
    curl -sSfL -o "$bin/kind" "https://github.com/kubernetes-sigs/kind/releases/download/$KIND_VERSION/kind-linux-amd64"
    echo "$KIND_SHA256  $bin/kind" | sha256sum -c -
    chmod +x "$bin/kind"
    "$bin/kind" version
    "$bin/kind" create cluster --name "$NAME" --image "$NODE_IMAGE" --wait 180s
    "$bin/kind" load docker-image spike-probe:1 --name "$NAME"
  else
    curl -sSfL -o "$bin/k3s" "https://github.com/k3s-io/k3s/releases/download/${K3S_VERSION/+/%2B}/k3s"
    echo "$K3S_SHA256  $bin/k3s" | sha256sum -c -
    sudo install -m 755 "$bin/k3s" /usr/local/bin/k3s
    sudo cp "$here/k3s-spike.service" /etc/systemd/system/k3s-spike.service
    sudo systemctl daemon-reload
    sudo systemctl start k3s-spike
    for _ in $(seq 60); do [ -e /etc/rancher/k3s/k3s.yaml ] && break; sleep 2; done
    wait_ready
    docker save spike-probe:1 | sudo k3s ctr images import -
  fi
  wait_ready

  echo "--- the node"
  # Facts only: printed, never fatal.
  if [ "$CLUSTER" = kind ]; then
    node_sh 'containerd --version; runc --version; kubelet --version; uname -r; grep -E "^version" /etc/containerd/config.toml; true'
  else
    node_sh "k3s --version; k3s ctr version; ls /var/lib/rancher/k3s/data/current/bin/ | tr '\n' ' '; echo; /var/lib/rancher/k3s/data/current/bin/runc --version; grep -E '^version' $K3S_CONTAINERD/config.toml; true"
  fi
  node_sh 'echo "node AppArmor: $(cat /sys/module/apparmor/parameters/enabled 2>&1); apparmor_parser: $(command -v apparmor_parser || echo none); securityfs: $(ls /sys/kernel/security/apparmor > /dev/null 2>&1 && echo yes || echo no)"; true'
  k version < /dev/null || true

  for ns in restricted baseline privileged; do
    k create namespace "spike-$ns" < /dev/null
    k label namespace "spike-$ns" "pod-security.kubernetes.io/enforce=$ns" pod-security.kubernetes.io/enforce-version=latest < /dev/null
    for _ in $(seq 60); do k get serviceaccount default -n "spike-$ns" > /dev/null 2>&1 < /dev/null && break; sleep 2; done
  done

  # The Localhost seccomp profile: Docker's default, with clone, unshare, mount, umount2 and pivot_root allowed
  # unconditionally (the default allows them only to a process holding CAP_SYS_ADMIN, and clone only without
  # namespace flags). The diff is printed: it is the whole security cost of the profile.
  curl -sSfL -o "$OUT/moby-default.json" "https://raw.githubusercontent.com/moby/profiles/$MOBY_PROFILES_COMMIT/seccomp/default.json"
  echo "$MOBY_SECCOMP_SHA256  $OUT/moby-default.json" | sha256sum -c -
  jq --argjson ns '["clone","unshare","mount","umount2","pivot_root"]' \
    '.syscalls |= ((map(.names -= $ns) | map(select((.names | length) > 0))) + [{"names": $ns, "action": "SCMP_ACT_ALLOW"}])' \
    "$OUT/moby-default.json" > "$OUT/spike-ns.json"
  diff <(jq -S . "$OUT/moby-default.json") <(jq -S . "$OUT/spike-ns.json") || true
  node_sh 'mkdir -p /var/lib/kubelet/seccomp/profiles'
  node_cp "$OUT/spike-ns.json" /var/lib/kubelet/seccomp/profiles/spike-ns.json

  # The Localhost AppArmor profile, where the node enforces AppArmor (k3s on the runner; kind's kubelet says AppArmor
  # isn't enabled on its node). Printed against containerd's own default, which is what pods get without it.
  if [ "$CLUSTER" = k3s ] && command -v apparmor_parser > /dev/null; then
    if sudo apparmor_parser -r -W "$here/spike-bwrap.apparmor"; then
      touch "$OUT/apparmor-installed"
    else
      echo "the spike-bwrap AppArmor profile didn't load: its profiles are skipped"
    fi
    sudo grep -E '^(cri-containerd|spike-bwrap)' /sys/kernel/security/apparmor/profiles || true
  fi
}

gvisor() {
  local d="$OUT/gvisor" cfg plugin
  mkdir -p "$d"
  curl -sSfL -o "$d/gvisor.tar.bz2" "https://storage.googleapis.com/gvisor/releases/release/$GVISOR_RELEASE/x86_64/gvisor.tar.bz2"
  echo "$GVISOR_SHA512  $d/gvisor.tar.bz2" | sha512sum -c -
  tar -xjf "$d/gvisor.tar.bz2" -C "$d"
  find "$d" -type f -printf '%P %s\n'
  # runsc finds its sidecars (gvisor_sentry, ...) in gvisor-bin/ next to itself.
  node_cp "$d/runsc" /usr/local/bin/runsc
  node_cp "$d/containerd-shim-runsc-v1" /usr/local/bin/containerd-shim-runsc-v1
  node_cp "$d/gvisor-bin" /usr/local/bin/gvisor-bin
  node_sh 'chmod -R a+rX /usr/local/bin/gvisor-bin; chmod 755 /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1; runsc --version'
  if [ "$CLUSTER" = kind ]; then cfg=/etc/containerd/config.toml; else cfg="$K3S_CONTAINERD/config.toml"; fi
  if node_sh "grep -q runsc $cfg"; then
    echo "containerd already has a runsc runtime"
  else
    # containerd 2's config version 3 names the CRI runtime plugin differently from version 2.
    plugin='io.containerd.grpc.v1.cri".containerd'
    if node_sh "grep -qE '^version *= *3' $cfg"; then plugin='io.containerd.cri.v1.runtime".containerd'; fi
    if [ "$CLUSTER" = kind ]; then
      printf '\n[plugins."%s.runtimes.runsc]\n  runtime_type = "io.containerd.runsc.v1"\n' "$plugin" | docker exec -i "$NODE" sh -c "cat >> $cfg"
      node_sh 'systemctl restart containerd'
    else
      # k3s regenerates config.toml on start: extend its base template instead.
      printf '{{ template "base" . }}\n\n[plugins."%s.runtimes.runsc]\n  runtime_type = "io.containerd.runsc.v1"\n' "$plugin" | sudo tee "$cfg.tmpl" > /dev/null
      sudo systemctl restart k3s-spike
    fi
  fi
  node_sh "grep -B1 -A2 runsc $cfg; true"
  sleep 5
  wait_ready
  printf '{"apiVersion":"node.k8s.io/v1","kind":"RuntimeClass","metadata":{"name":"gvisor"},"handler":"runsc"}' | k apply -f -
  touch "$OUT/gvisor-installed"
}

# The newest Warning event of a pod, if any.
warning_of() { k get events -n "$1" --field-selector "involvedObject.name=$2,type=Warning" -o jsonpath='{.items[-1:].message}' < /dev/null 2> /dev/null || true; }

probe() {
  local pass="$1" out="$OUT/$1" i=0 profile nss ns name admitted denials msg phase line warn t
  mkdir -p "$out"
  local gv=0 aa=0
  [ -e "$OUT/gvisor-installed" ] && gv=1
  [ -e "$OUT/apparmor-installed" ] && aa=1
  mapfile -t list < <(GVISOR="$gv" APPARMOR="$aa" node "$here/pods.mjs" list)
  for line in "${list[@]}"; do
    profile="${line% *}"
    nss="${line##* }"
    i=$((i + 1))
    name="probe-$pass-$i"
    admitted=''
    denials=''
    for ns in ${nss//,/ }; do
      if msg="$(node "$here/pods.mjs" pod "$profile" "$ns" "$name" | k apply -f - 2>&1)"; then
        admitted="$ns"
        break
      fi
      denials+="$ns: $msg; "
    done
    {
      echo "INFO|cluster|$CLUSTER"
      echo "INFO|profile|$profile"
      echo "INFO|admitted|${admitted:-none}"
      printf 'INFO|denied|%s\n' "$(printf '%s' "$denials" | tr '\n|' ' /')"
    } > "$out/$i.log"
    echo "== $CLUSTER / $pass / $profile: admitted under ${admitted:-nothing}"
    [ -n "$admitted" ] || continue
    # Wait for the probe to finish; give up on a pod that can't start (a Warning event and still not running after
    # 40s), so a refused pod costs seconds, not minutes.
    phase=''
    warn=''
    for t in $(seq 90); do
      phase="$(k get pod -n "spike-$admitted" "$name" -o jsonpath='{.status.phase}' < /dev/null 2> /dev/null || true)"
      case "$phase" in Succeeded | Failed) break ;; esac
      if [ "$t" -ge 20 ] && [ "$phase" != Running ]; then
        warn="$(warning_of "spike-$admitted" "$name")"
        [ -n "$warn" ] && break
      fi
      sleep 2
    done
    printf 'INFO|phase|%s\n' "$phase" >> "$out/$i.log"
    k logs -n "spike-$admitted" "$name" < /dev/null >> "$out/$i.log" 2>&1 || true
    if [ "$phase" != Succeeded ]; then
      [ -n "$warn" ] || warn="$(warning_of "spike-$admitted" "$name")"
      printf 'INFO|why|%s %s\n' "$(printf '%s' "$warn" | tr '\n|' ' /')" "$(k get pod -n "spike-$admitted" "$name" -o jsonpath='{.status.containerStatuses[0].state}' < /dev/null 2>&1 | tr '\n|' ' /')" >> "$out/$i.log"
    fi
    cat "$out/$i.log"
    k delete pod -n "spike-$admitted" "$name" --wait=false < /dev/null > /dev/null 2>&1 || true
  done
}

case "${1:-}" in
  host) host ;;
  cluster) cluster ;;
  gvisor) gvisor ;;
  probe) probe "$2" ;;
  table) node "$here/table.mjs" "$OUT" ;;
  *) echo "usage: run.sh host | cluster | gvisor | probe <pass> | table" >&2; exit 2 ;;
esac
