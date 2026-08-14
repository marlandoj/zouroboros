#!/usr/bin/env bash
set -euo pipefail

workdir="${ZBC_WORKDIR:?ZBC_WORKDIR is required}"
adapter="${ZBC_ADAPTER_BIN:?ZBC_ADAPTER_BIN is required}"

args=(
  --die-with-parent
  --new-session
  --unshare-pid
  --proc /proc
  --dev /dev
  --tmpfs /tmp
  --ro-bind /usr /usr
  --ro-bind /etc /etc
  --symlink usr/bin /bin
  --symlink usr/lib /lib
  --symlink usr/lib64 /lib64
  --dir /root
  --dir /root/.cache
  --dir /root/.config
)

if [[ -d /run/systemd/resolve ]]; then
  args+=(
    --dir /run
    --dir /run/systemd
    --ro-bind /run/systemd/resolve /run/systemd/resolve
  )
fi

parent="$(dirname "$workdir")"
current=""
IFS='/' read -r -a segments <<< "${parent#/}"
for segment in "${segments[@]}"; do
  current="$current/$segment"
  args+=(--dir "$current")
done

args+=(
  --bind "$workdir" "$workdir"
  --chdir "$workdir"
  --setenv HOME /root
  --setenv ZOUROBENCH_CODE_SANDBOX 1
)

exec /usr/bin/bwrap "${args[@]}" "$adapter" "$@"
