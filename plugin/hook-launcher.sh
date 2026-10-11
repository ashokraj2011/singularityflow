#!/bin/bash
# Non-login GUI hooks cannot assume the user's shell initialization or npm bin PATH.
# Resolve only PATH applications and fixed system installation prefixes; never scan repositories.
set -u
action=${1:-}
case "$action" in
  boundary-turn|boundary-guard|boundary-after|boundary-end|agent-start) ;;
  *) printf '%s\n' '{}'; exit 0 ;;
esac
launcher_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
node_path=$(command -v node 2>/dev/null || true)
if [[ "$node_path" != /* || ! -x "$node_path" ]]; then
  node_path=''
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /opt/local/bin/node /usr/bin/node; do
    if [[ -f "$candidate" && -x "$candidate" ]]; then node_path=$candidate; break; fi
  done
fi
if [[ -n "$node_path" ]]; then
  cli_path=$(command -v singularity-flow 2>/dev/null || true)
  # Pass candidates as arguments, not shell text. The Node bootstrap verifies the package/entry.
  exec "$node_path" "$launcher_dir/hook-launcher.mjs" "$action" "$cli_path" \
    /opt/homebrew/bin/singularity-flow /usr/local/bin/singularity-flow /opt/local/bin/singularity-flow
fi
if [[ "$action" == boundary-guard ]]; then
  printf '%s\n' '{"permissionDecision":"deny","permissionDecisionReason":"SFLOW_HOOK_RUNTIME_UNAVAILABLE: Node.js is unavailable to Copilot. Repair the SFlow installation from a human terminal, run singularity-flow plugin install, and reload VS Code. Preserve the Story; changing its ID will not repair the hook."}'
else
  printf '%s\n' '{}'
fi
