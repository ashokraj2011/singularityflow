#!/usr/bin/env bash
set -Eeuo pipefail
managed_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
managed_node="$(bash "$managed_source/runtime/bootstrap.sh")"
exec "$managed_node" "$managed_source/runtime/source-install.mjs" "$@"
