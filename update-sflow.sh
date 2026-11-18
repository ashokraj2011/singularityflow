#!/usr/bin/env bash
set -Eeuo pipefail
updater_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if command -v node >/dev/null 2>&1 && node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  updater_node="$(command -v node)"
else
  updater_node="$(bash "$updater_dir/runtime/bootstrap.sh")"
fi
exec "$updater_node" "$updater_dir/runtime/update.mjs" "$@"
