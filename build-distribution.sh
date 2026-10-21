#!/usr/bin/env bash
set -Eeuo pipefail
build_source="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
build_node="$(bash "$build_source/runtime/bootstrap.sh")"
exec "$build_node" "$build_source/runtime/build-distribution.mjs" "$@"
