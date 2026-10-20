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
managed_root="${SINGULARITY_FLOW_ENGINE_HOME:-${HOME:-}/.singularity-flow/engine}"
if [[ "$managed_root" == /* && -f "$managed_root/active" ]]; then
  IFS='|' read -r managed_schema managed_runtime managed_release managed_extra < "$managed_root/active"
  if [[ "$managed_schema" == 1 && -z "${managed_extra:-}" && "$managed_runtime" == node-v26.* \
    && "$managed_runtime" != *[!a-zA-Z0-9.-]* && "$managed_release" =~ ^[a-f0-9]{64}$ ]]; then
    managed_node="$managed_root/runtimes/$managed_runtime/bin/node"
    managed_cli="$managed_root/releases/$managed_release/node_modules/singularity-flow/bin/singularity-flow.mjs"
    if [[ -x "$managed_node" && -f "$managed_cli" ]]; then
      exec "$managed_node" "$launcher_dir/hook-launcher.mjs" "$action" "$managed_cli"
    fi
  fi
  # A broken managed selection must not silently fall through to a different engine/version.
  if [[ "$action" == boundary-guard ]]; then
    printf '%s\n' '{"permissionDecision":"deny","permissionDecisionReason":"SFLOW_HOOK_RUNTIME_UNAVAILABLE: The managed SFlow engine is incomplete. Repair its installation; preserve the Story."}'
  else printf '%s\n' '{}'; fi
  exit 0
fi
node_path=$(command -v node 2>/dev/null || true)
if [[ "$node_path" != /* || ! -x "$node_path" ]]; then
  node_path=''
  for candidate in /opt/homebrew/bin/node /usr/local/bin/node /opt/local/bin/node /usr/bin/node; do
    if [[ -f "$candidate" && -x "$candidate" ]]; then node_path=$candidate; break; fi
  done
fi
if [[ -n "$node_path" ]]; then
  # Copilot runs the guard before every tool, in every chat. With no SFlow turn recorded on this
  # machine the runtime's guard, after-tool and end hooks return no decision, so give that answer
  # here instead of starting Node (100-180 ms a call). Any entry, including the marker a runtime
  # that failed to load leaves, sends the hook to Node as before. Mirrors copilotModeFile().
  case "$action" in
    boundary-guard|boundary-after|boundary-end)
      mode_file=${SINGULARITY_FLOW_COPILOT_MODE_FILE:-}
      if [[ -z "$mode_file" && "${HOME:-}" == /* ]]; then mode_file="$HOME/.singularity-flow/copilot-mode.json"; fi
      if [[ "$mode_file" == /* && "$mode_file" != */ && "$mode_file" != *'/./'* && "$mode_file" != *'/../'* ]]; then
        shopt -s nullglob
        boundary_entries=("${mode_file%/*}/copilot-boundaries"/*)
        shopt -u nullglob
        if (( ${#boundary_entries[@]} == 0 )); then
          cat >/dev/null 2>&1 || true
          printf '%s\n' '{}'
          exit 0
        fi
      fi ;;
  esac
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
