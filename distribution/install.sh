#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ "${1:-}" == '--managed-runtime' ]]; then
  managed_node="$(bash "$SCRIPT_DIR/node-bootstrap.sh")"
  export SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT="$SCRIPT_DIR/install.sh"
  exec "$managed_node" "$SCRIPT_DIR/bootstrap.mjs" install "$@"
fi
command -v node >/dev/null 2>&1 || { printf '%s\n' 'Node.js 22 or newer is required.' >&2; exit 1; }
export SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT="$SCRIPT_DIR/install.sh"
exec node "$SCRIPT_DIR/bootstrap.mjs" install "$@"
