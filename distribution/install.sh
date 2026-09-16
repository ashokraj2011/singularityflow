#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
command -v node >/dev/null 2>&1 || { printf '%s\n' 'Node.js 20 or newer is required.' >&2; exit 1; }
export SINGULARITY_FLOW_DISTRIBUTION_ENTRYPOINT="$SCRIPT_DIR/install.sh"
exec node "$SCRIPT_DIR/bootstrap.mjs" install "$@"
