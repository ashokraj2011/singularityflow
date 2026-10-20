#!/usr/bin/env bash
# Private Node bootstrap. Does not require Node/npm, edit profiles, or replace global programs.
set -Eeuo pipefail
runtime_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
runtime_root="${SINGULARITY_FLOW_ENGINE_HOME:-${HOME:?HOME is required}/.singularity-flow/engine}"
[[ "$runtime_root" == /* ]] || { printf '%s\n' 'SFlow engine home must be absolute.' >&2; exit 1; }
case "$(uname -s)" in Darwin) runtime_os=darwin ;; Linux) runtime_os=linux ;; *) printf '%s\n' 'Use runtime/bootstrap.ps1 on Windows.' >&2; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) runtime_arch=arm64 ;; x86_64|amd64) runtime_arch=x64 ;; *) printf '%s\n' 'Unsupported Node CPU architecture.' >&2; exit 1 ;; esac
runtime_row="$(awk -v p="$runtime_os" -v a="$runtime_arch" '$1==p && $2==a {print $3 " " $4 " " $5}' "$runtime_script_dir/node-runtime.lock")"
read -r runtime_version runtime_archive runtime_sha <<< "$runtime_row"
[[ "$runtime_row" != *$'\n'* && "$runtime_version" =~ ^26\.[0-9]+\.[0-9]+$ && "$runtime_sha" =~ ^[a-f0-9]{64}$ \
  && "$runtime_archive" == "node-v${runtime_version}-${runtime_os}-${runtime_arch}.tar.gz" ]] || { printf '%s\n' 'Invalid pinned Node runtime lock.' >&2; exit 1; }
runtime_id="node-v${runtime_version}-${runtime_os}-${runtime_arch}"
runtime_target="$runtime_root/runtimes/$runtime_id"
runtime_node="$runtime_target/bin/node"
umask 077
runtime_check_private() {
  local candidate="$1" permissions
  [[ -O "$candidate" && ! -L "$candidate" ]] || { printf '%s\n' 'Private Node paths must be owned by this user and must not be links.' >&2; exit 1; }
  if [[ "$runtime_os" == darwin ]]; then permissions="$(stat -f '%Lp' "$candidate")"; else permissions="$(stat -c '%a' "$candidate")"; fi
  [[ "$permissions" =~ ^[0-7]{3,4}$ ]] && (( (8#$permissions & 8#022) == 0 )) \
    || { printf '%s\n' 'Private Node paths must not be writable by other users.' >&2; exit 1; }
}
for runtime_dir in "$runtime_root" "$runtime_root/runtimes"; do
  [[ ! -L "$runtime_dir" ]] || { printf '%s\n' 'SFlow runtime directories must not be symbolic links.' >&2; exit 1; }
  mkdir -p "$runtime_dir"
  runtime_check_private "$runtime_dir"
done
if [[ -e "$runtime_target" ]]; then
  runtime_check_private "$runtime_target"
  runtime_check_private "$runtime_target/bin"
  runtime_check_private "$runtime_node"
  [[ ! -L "$runtime_target" && -f "$runtime_node" && ! -L "$runtime_node" && -f "$runtime_target/.sflow-archive-sha256" \
    && "$(<"$runtime_target/.sflow-archive-sha256")" == "$runtime_sha" ]] || { printf '%s\n' 'Existing private Node is incomplete; preserve it and repair the installation.' >&2; exit 1; }
  [[ "$("$runtime_node" --version)" == "v$runtime_version" ]] || exit 1
  printf '%s\n' "$runtime_node"; exit 0
fi
runtime_stage="$(mktemp -d "$runtime_root/runtimes/.prepare.XXXXXX")"
trap 'rm -rf -- "$runtime_stage"' EXIT
runtime_file="$runtime_stage/$runtime_archive"
if [[ -n "${SINGULARITY_FLOW_NODE_ARCHIVE_DIR:-}" ]]; then
  cp -- "$SINGULARITY_FLOW_NODE_ARCHIVE_DIR/$runtime_archive" "$runtime_file"
else
  runtime_mirror="${SINGULARITY_FLOW_NODE_MIRROR:-https://nodejs.org/dist}"
  [[ "$runtime_mirror" == https://* && "$runtime_mirror" != *'@'* && "$runtime_mirror" != *'?'* && "$runtime_mirror" != *'#'* ]] || { printf '%s\n' 'Node mirror must use HTTPS without embedded credentials.' >&2; exit 1; }
  printf 'Preparing private Node %s for %s/%s…\n' "$runtime_version" "$runtime_os" "$runtime_arch" >&2
  curl --fail --location --proto '=https' --proto-redir '=https' --connect-timeout 30 --max-time 600 \
    --output "$runtime_file" "${runtime_mirror%/}/v$runtime_version/$runtime_archive" >&2
fi
if command -v shasum >/dev/null 2>&1; then runtime_actual="$(shasum -a 256 "$runtime_file")"; else runtime_actual="$(sha256sum "$runtime_file")"; fi
[[ "${runtime_actual%% *}" == "$runtime_sha" ]] || { printf '%s\n' 'Node archive checksum mismatch; nothing was activated.' >&2; exit 1; }
# Only a digest-pinned official archive reaches extraction. Keep its LICENSE and notices intact.
mkdir "$runtime_stage/unpack"
tar -xzf "$runtime_file" -C "$runtime_stage/unpack"
runtime_unpacked="$runtime_stage/unpack/node-v${runtime_version}-${runtime_os}-${runtime_arch}"
[[ -f "$runtime_unpacked/LICENSE" && -x "$runtime_unpacked/bin/node" && ! -L "$runtime_unpacked/bin/node" ]] || exit 1
[[ "$("$runtime_unpacked/bin/node" --version)" == "v$runtime_version" ]] || exit 1
printf '%s\n' "$runtime_sha" > "$runtime_unpacked/.sflow-archive-sha256"
# A concurrent installer may have prepared the same immutable runtime. Never merge/overwrite it.
if mkdir "$runtime_root/.runtime-lock" 2>/dev/null; then
  trap 'rmdir "$runtime_root/.runtime-lock" 2>/dev/null || true; rm -rf -- "$runtime_stage"' EXIT
  [[ ! -e "$runtime_target" ]] || { printf '%s\n' 'Another installer prepared Node; retry installation.' >&2; exit 1; }
  mv "$runtime_unpacked" "$runtime_target"
else
  printf '%s\n' 'Another runtime preparation is active. Retry after it finishes; do not delete recovery files.' >&2; exit 1
fi
printf '%s\n' "$runtime_node"
