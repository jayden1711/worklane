#!/usr/bin/env bash
# SPIKE (do not merge), #698 decision 5: can Claude Code's command sandbox (bubblewrap, through Anthropic's
# sandbox-runtime) start inside a locked-down Kubernetes pod? CI only (.github/workflows/spike-sandbox-pod.yml), on a
# throwaway GitHub-hosted runner; it needs docker and sudo. No model is called.
#   run.sh host                 the runner's kernel, the AppArmor userns sysctl, docker, containerd and runc
#   run.sh cluster              a kind cluster (pinned kind and node image), the probe image, the namespaces, the
#                               Localhost seccomp profile, and the node's own containerd/runc/kubelet facts
#   run.sh gvisor               gVisor as RuntimeClass "gvisor" (best effort: on failure the profile is skipped)
#   run.sh probe <pass>         every profile in pods.mjs, one pod each; logs under $OUT/<pass>/
#   run.sh table                the results table (also to the job summary)
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
OUT="${OUT:-$RUNNER_TEMP/spike-sandbox-pod}"
CLUSTER=spike-sbx
NODE="$CLUSTER-control-plane"
KIND_VERSION=v0.33.0
KIND_SHA256=aee6151561422756b764a4ae28e7f44cda5af5a9eead3cc9985112b1de8d8e0d
NODE_IMAGE='kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5'
GVISOR_RELEASE=20260928
GVISOR_SHA512=c8d3a9fd4d4c4f5b8ff213caa4517356be128d18659ec4cde37828fe797f61a9725a602a846c81a8ed19c057a996515d31c081eba343ed4613a89951ba32ed59
# Docker's default seccomp profile (github.com/moby/profiles, tag seccomp/v0.2.4), the base of the Localhost profile.
MOBY_PROFILES_COMMIT=245180c51918481c0525424b3ee025d2b435d46c
MOBY_SECCOMP_SHA256=785b2429264afba4d594320337cb17f144f3c7d51585f9805eef72e28f4f9334
mkdir -p "$OUT"

# kubectl inside the node (the node image ships it), so there's no kubectl download to pin.
k() { docker exec -i "$NODE" kubectl --kubeconfig /etc/kubernetes/admin.conf "$@"; }
node_sh() { docker exec "$NODE" sh -c "$1" < /dev/null; }

host() {
  echo "kernel: $(uname -r) ($(uname -m))"
  grep PRETTY_NAME /etc/os-release
  echo "kernel.apparmor_restrict_unprivileged_userns: $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>&1)"
  echo "kernel.unprivileged_userns_clone: $(sysctl -n kernel.unprivileged_userns_clone 2>&1)"
  echo "user.max_user_namespaces: $(sysctl -n user.max_user_namespaces 2>&1)"
  echo "AppArmor enabled: $(cat /sys/module/apparmor/parameters/enabled 2>&1)"
  docker version --format 'docker server {{.Server.Version}}'
  docker info --format 'docker runtimes: {{json .Runtimes}}; default {{.DefaultRuntime}}; security {{json .SecurityOptions}}'
  echo "host containerd: $(containerd --version 2>&1 || true)"
  echo "host runc: $(runc --version 2>&1 | tr '\n' ' ' || true)"
}

cluster() {
  local bin="$OUT/bin" img="$OUT/image"
  mkdir -p "$bin" "$img/srt"
  curl -sSfL -o "$bin/kind" "https://github.com/kubernetes-sigs/kind/releases/download/$KIND_VERSION/kind-linux-amd64"
  echo "$KIND_SHA256  $bin/kind" | sha256sum -c -
  chmod +x "$bin/kind"
  "$bin/kind" version

  # The probe image: sandbox-runtime from this repo's lockfile (a runtime dependency already: no new package).
  cp "$repo/package.json" "$repo/package-lock.json" "$img/srt/"
  (cd "$img/srt" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
  cp "$here/Dockerfile" "$here/probe.sh" "$here/wrap.mjs" "$img/"
  docker build -t spike-probe:1 "$img"
  docker run --rm --entrypoint sh spike-probe:1 -c 'dpkg-query -W bubblewrap socat ripgrep util-linux; node --version; /opt/srt/node_modules/.bin/srt --version'

  "$bin/kind" create cluster --name "$CLUSTER" --image "$NODE_IMAGE" --wait 180s
  "$bin/kind" load docker-image spike-probe:1 --name "$CLUSTER"

  echo "--- the node"
  node_sh 'containerd --version; runc --version; kubelet --version; uname -r'
  node_sh 'grep -E "^version" /etc/containerd/config.toml; grep -iE "seccomp|userns|feature" /var/lib/kubelet/config.yaml || true'
  node_sh 'echo "node AppArmor: $(cat /sys/module/apparmor/parameters/enabled 2>&1); apparmor_parser: $(command -v apparmor_parser || echo none)"'
  k version

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
  docker cp "$OUT/spike-ns.json" "$NODE:/var/lib/kubelet/seccomp/profiles/spike-ns.json"
}

gvisor() {
  local d="$OUT/gvisor"
  mkdir -p "$d"
  curl -sSfL -o "$d/gvisor.tar.bz2" "https://storage.googleapis.com/gvisor/releases/release/$GVISOR_RELEASE/x86_64/gvisor.tar.bz2"
  echo "$GVISOR_SHA512  $d/gvisor.tar.bz2" | sha512sum -c -
  tar -xjf "$d/gvisor.tar.bz2" -C "$d"
  find "$d" -type f -printf '%P %s\n'
  local runsc shim
  runsc="$(find "$d" -type f -name runsc | head -n 1)"
  shim="$(find "$d" -type f -name containerd-shim-runsc-v1 | head -n 1)"
  [ -n "$runsc" ] && [ -n "$shim" ]
  docker cp "$runsc" "$NODE:/usr/local/bin/runsc"
  docker cp "$shim" "$NODE:/usr/local/bin/containerd-shim-runsc-v1"
  node_sh 'chmod 755 /usr/local/bin/runsc /usr/local/bin/containerd-shim-runsc-v1; runsc --version'
  # containerd 2 (config version 3) names the CRI runtime plugin differently from containerd 1 (version 2).
  local plugin='io.containerd.grpc.v1.cri".containerd'
  if node_sh 'grep -qE "^version *= *3" /etc/containerd/config.toml'; then plugin='io.containerd.cri.v1.runtime".containerd'; fi
  printf '\n[plugins."%s.runtimes.runsc]\n  runtime_type = "io.containerd.runsc.v1"\n' "$plugin" | docker exec -i "$NODE" sh -c 'cat >> /etc/containerd/config.toml'
  node_sh 'tail -n 3 /etc/containerd/config.toml; systemctl restart containerd'
  for _ in $(seq 60); do k get nodes < /dev/null | grep -q ' Ready ' && break; sleep 2; done
  printf '{"apiVersion":"node.k8s.io/v1","kind":"RuntimeClass","metadata":{"name":"gvisor"},"handler":"runsc"}' | k apply -f -
  touch "$OUT/gvisor-installed"
}

probe() {
  local pass="$1" out="$OUT/$1" i=0 profile nss ns name admitted denials msg phase line
  mkdir -p "$out"
  local gv=0
  [ -e "$OUT/gvisor-installed" ] && gv=1
  mapfile -t list < <(GVISOR="$gv" node "$here/pods.mjs" list)
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
      echo "INFO|profile|$profile"
      echo "INFO|admitted|${admitted:-none}"
      printf 'INFO|denied|%s\n' "$(printf '%s' "$denials" | tr '\n|' ' /')"
    } > "$out/$i.log"
    echo "== $pass / $profile: admitted under ${admitted:-nothing}"
    [ -n "$admitted" ] || continue
    phase=''
    for _ in $(seq 90); do
      phase="$(k get pod -n "spike-$admitted" "$name" -o jsonpath='{.status.phase}' < /dev/null 2> /dev/null || true)"
      case "$phase" in Succeeded | Failed) break ;; esac
      sleep 2
    done
    printf 'INFO|phase|%s\n' "$phase" >> "$out/$i.log"
    k logs -n "spike-$admitted" "$name" < /dev/null >> "$out/$i.log" 2>&1 || true
    if [ "$phase" != Succeeded ]; then
      printf 'INFO|why|%s\n' "$(k get pod -n "spike-$admitted" "$name" -o jsonpath='{.status.containerStatuses[0].state}' < /dev/null 2>&1 | tr '\n|' ' /')" >> "$out/$i.log"
      k describe pod -n "spike-$admitted" "$name" < /dev/null | tail -n 25 || true
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
