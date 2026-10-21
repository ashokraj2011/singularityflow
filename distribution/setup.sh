#!/usr/bin/env bash
set -Eeuo pipefail
setup_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec bash "$setup_directory/install.sh" --managed-runtime "$@"
