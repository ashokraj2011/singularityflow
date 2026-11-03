#!/bin/bash
# Non-login GUI hooks cannot assume the user's shell initialization or npm bin PATH.
# Resolve only PATH applications and fixed system installation prefixes; never scan repositories.
set -u
action=${1:-}
case "$action" in
  boundary-turn|boundary-guard|boundary-after|boundary-end|agent-start|boundary-stop|boundary-failure) ;;
  *) printf '%s\n' '{}'; exit 0 ;;
esac
launcher_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# With no SFlow turn recorded the runtime's guard still refuses a person's own step in any prompt
# (personStepGuard in copilot-repository-boundary.mjs), and it looks only at a call that names SFlow.
# So the guard keeps its no-Node answer only for a payload that cannot: held here, read once, and
# given to Node unchanged when it might. Read whole: a bounded reader such as head over-reads a pipe
# and loses the rest. Over 1 MiB it is not inspected; Node judges it.
hook_input='' hook_input_held=0 hook_input_large=0
hold_hook_input() {
  local LC_ALL=C reader
  reader=$(command -v cat 2>/dev/null) || return 1
  hook_input=$("$reader" && printf .)
  hook_input_held=1
  # A reader that failed part way leaves no final dot: Node judges what it read.
  if [[ $hook_input == *. ]]; then hook_input=${hook_input%.}; else hook_input_large=1; fi
  if (( ${#hook_input} > 1048576 )); then hook_input_large=1; fi
}
# The guard's own test, /singularity-flow|sflow/iu on the tool calls or the verified entry (which ends
# in singularity-flow.mjs), on the raw JSON less the session's folder, which the guard does not read.
# Under that test U+017F (long s) is an s. An escaped printable ASCII character or a long s could
# spell either word without its letters; no JSON writer Copilot uses escapes one, so either goes to Node.
hook_input_names_sflow() {
  local LC_ALL=C text=$hook_input before after
  if (( hook_input_large )); then return 0; fi
  if [[ $text == *'"cwd":"'* ]]; then
    before=${text%%'"cwd":"'*} after=${text#*'"cwd":"'}
    text=$before${after#*\"}
  fi
  [[ $text == *[Ss][Ff][Ll][Oo][Ww]* || $text == *[Ss][Ii][Nn][Gg][Uu][Ll][Aa][Rr][Ii][Tt][Yy]-[Ff][Ll][Oo][Ww]* \
    || $text == *$'\305\277'* || $text == *\\u00[2-7][0-9A-Fa-f]* || $text == *\\u017[Ff]* ]]
}
# Answered here, or the bytes go to Node as the host sent them.
quiet_hook() {
  if [[ "$action" == boundary-guard ]]; then
    # No reader to hold the payload with: Node reads it, as with a recorded turn.
    hold_hook_input || return 1
    if hook_input_names_sflow; then return 1; fi
  else cat >/dev/null 2>&1 || true; fi
  printf '%s\n' '{}'; exit 0
}
run_hook() {
  if (( ! hook_input_held )); then exec "$@"; fi
  exec "$@" < <(printf '%s' "$hook_input")
}
managed_root="${SINGULARITY_FLOW_ENGINE_HOME:-${HOME:-}/.singularity-flow/engine}"
if [[ "$managed_root" == /* && -f "$managed_root/active" ]]; then
  IFS='|' read -r managed_schema managed_runtime managed_release managed_extra < "$managed_root/active"
  if [[ "$managed_schema" == 1 && -z "${managed_extra:-}" && "$managed_runtime" == node-v26.* \
    && "$managed_runtime" != *[!a-zA-Z0-9.-]* && "$managed_release" =~ ^[a-f0-9]{64}$ ]]; then
    managed_node="$managed_root/runtimes/$managed_runtime/bin/node"
    managed_cli="$managed_root/releases/$managed_release/node_modules/singularity-flow/bin/singularity-flow.mjs"
    if [[ -x "$managed_node" && -f "$managed_cli" ]]; then
      case "$action" in
        boundary-guard|boundary-after|boundary-end|boundary-stop|boundary-failure)
          managed_mode=${SINGULARITY_FLOW_COPILOT_MODE_FILE:-${HOME:-}/.singularity-flow/copilot-mode.json}
          if [[ "$managed_mode" == /* && "$managed_mode" != */ && "$managed_mode" != *'/./'* && "$managed_mode" != *'/../'* ]]; then
            shopt -s nullglob
            managed_boundaries=("${managed_mode%/*}/copilot-boundaries"/*)
            shopt -u nullglob
            if (( ${#managed_boundaries[@]} == 0 )); then quiet_hook; fi
          fi ;;
        # The engine's PATH entry comes from a shell profile, which a GUI-started host never read.
        # Off PATH, --cli-off-path has the turn name the verified Node and entry instead.
        boundary-turn) command -v singularity-flow >/dev/null 2>&1 \
          || exec "$managed_node" "$launcher_dir/hook-launcher.mjs" "$action" "$managed_cli" --cli-off-path ;;
      esac
      run_hook "$managed_node" "$launcher_dir/hook-launcher.mjs" "$action" "$managed_cli"
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
  # machine the runtime's after-tool and end hooks return no decision, and so does its guard for a
  # call that names no SFlow command, so give that answer here instead of starting Node (100-180 ms
  # a call). Any entry, including the marker a runtime that failed to load leaves, sends the hook
  # to Node as before. Mirrors copilotModeFile().
  case "$action" in
    boundary-guard|boundary-after|boundary-end|boundary-stop|boundary-failure)
      mode_file=${SINGULARITY_FLOW_COPILOT_MODE_FILE:-}
      if [[ -z "$mode_file" && "${HOME:-}" == /* ]]; then mode_file="$HOME/.singularity-flow/copilot-mode.json"; fi
      if [[ "$mode_file" == /* && "$mode_file" != */ && "$mode_file" != *'/./'* && "$mode_file" != *'/../'* ]]; then
        shopt -s nullglob
        boundary_entries=("${mode_file%/*}/copilot-boundaries"/*)
        shopt -u nullglob
        if (( ${#boundary_entries[@]} == 0 )); then quiet_hook; fi
      fi ;;
  esac
  cli_path=$(command -v singularity-flow 2>/dev/null || true)
  # Pass candidates as arguments, not shell text. The Node bootstrap verifies the package/entry.
  # Copilot's shell shares this PATH: off it, the marker has the turn name the verified Node and entry.
  run_hook "$node_path" "$launcher_dir/hook-launcher.mjs" "$action" "${cli_path:---cli-off-path}" \
    /opt/homebrew/bin/singularity-flow /usr/local/bin/singularity-flow /opt/local/bin/singularity-flow
fi
if [[ "$action" == boundary-guard ]]; then
  printf '%s\n' '{"permissionDecision":"deny","permissionDecisionReason":"SFLOW_HOOK_RUNTIME_UNAVAILABLE: Node.js is unavailable to Copilot. Repair the SFlow installation from a human terminal, run singularity-flow plugin install, and reload VS Code. Preserve the Story; changing its ID will not repair the hook."}'
else
  printf '%s\n' '{}'
fi
