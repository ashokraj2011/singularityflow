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
# [PCR:REQ-031] Run as Copilot's plugin (the host names this folder), leave this folder in a marker, so a repository's
# own hooks (.github/hooks/sflow-hook.sh) answer {} and each event is handled once. Never when a repository hook
# hands an event here, which names no plugin folder. Mirrors pluginMarkerFile() in src/repository-hooks.mjs.
note_plugin() {
  local root=${PLUGIN_ROOT:-${COPILOT_PLUGIN_ROOT:-}} mode=${SINGULARITY_FLOW_COPILOT_MODE_FILE:-} marker marked=''
  [[ -n "$root" && "$root" -ef "$launcher_dir" ]] || return 0
  if [[ -z "$mode" && "${HOME:-}" == /* ]]; then mode="$HOME/.singularity-flow/copilot-mode.json"; fi
  [[ "$mode" == /* && "$mode" != */ && "$mode" != *'/./'* && "$mode" != *'/../'* ]] || return 0
  marker="${mode%/*}/copilot-plugin"
  [[ -f "$marker" ]] && IFS= read -r marked < "$marker"
  [[ "$marked" == "$launcher_dir" ]] && return 0
  mkdir -p "${mode%/*}" 2>/dev/null && printf '%s\n' "$launcher_dir" > "$marker.$$" 2>/dev/null && mv -f "$marker.$$" "$marker" 2>/dev/null
  rm -f "$marker.$$" 2>/dev/null
  return 0
}
note_plugin
# With no SFlow turn recorded the runtime's guard still refuses a person's own step in any prompt
# (personStepGuard in copilot-repository-boundary.mjs), and it looks only at a call that names SFlow,
# or a file that may hold secrets.
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
hook_input_goes_to_node() {
  local LC_ALL=C text=$hook_input before after
  if (( hook_input_large )); then return 0; fi
  if [[ $text == *'"cwd":"'* ]]; then
    before=${text%%'"cwd":"'*} after=${text#*'"cwd":"'}
    text=$before${after#*\"}
  fi
  [[ $text == *[Ss][Ff][Ll][Oo][Ww]* || $text == *[Ss][Ii][Nn][Gg][Uu][Ll][Aa][Rr][Ii][Tt][Yy]-[Ff][Ll][Oo][Ww]* \
    || $text == *$'\305\277'* || $text == *\\u00[2-7][0-9A-Fa-f]* || $text == *\\u017[Ff]* ]] && return 0
  # A file that may hold secrets goes to Node too: outside a turn the runtime refuses one in a repository
  # that uses SFlow (plainChatGuard). A dotfile, a settings or key extension (not `process.env.X`, `res.json(`
  # or `.keys()`), or the word. These names come from src/local-config-policy.mjs; a false match costs one Node start.
  # So does a search for a credential word (CREDENTIAL_WORD in src/copilot-environment-files-guard.mjs): the line it prints may hold the value.
  local names='(^|[^]a-z0-9_)])\.env|\.(env|ya?ml|properties|toml|ini|cfg|conf|json|pem|key|p12|pfx|jks|keystore)($|[^a-z0-9_.([])|secret|credential' status
  local searches='grep|(^|[^a-z0-9_])(rg|ag|ack)($|[^a-z0-9_])' words='pass|pwd|token|key|auth'
  shopt -s nocasematch
  [[ $text =~ $names ]]; status=$?
  if (( status != 0 )) && [[ $text =~ $searches ]] && [[ $text =~ $words ]]; then status=0; fi
  shopt -u nocasematch
  return "$status"
}
# The session's folder as the host wrote it, with or without spaces around the colon, or nothing: an escaped
# character is not unescaped here.
hook_input_cwd() {
  local LC_ALL=C pattern='"cwd"[[:space:]]*:[[:space:]]*"(/[^"\\]*)"'
  [[ $hook_input =~ $pattern ]] || return 1
  printf '%s' "${BASH_REMATCH[1]}"
}
# A repository that uses SFlow, from its files alone (usesSflow in src/copilot-environment-files-guard.mjs): its
# singularity/*.yml, or SFlow's folder or branch under its Git directory. Walked up from the session's folder to
# the first checkout, with shell builtins only; a nested repository is judged on its own. Plain-chat routing's
# guard runs in Node for these [PCR:REQ-001]; Node judges each call by its own paths.
cwd_uses_sflow() {
  local LC_ALL=C directory=$1 depth=0 line common
  [[ $directory == /* ]] || return 1
  while (( depth < 64 )); do
    if [[ -e "$directory/.git" ]]; then
      [[ -f "$directory/singularity/workflow.yml" || -f "$directory/singularity/capabilities.yml" || -f "$directory/singularity/environments.yml" ]] && return 0
      common="$directory/.git"
      if [[ -f "$common" ]]; then
        IFS= read -r line < "$common" || return 1
        [[ $line == 'gitdir: '* ]] || return 1
        common=${line#gitdir: }
        [[ $common == /* ]] || common="$directory/$common"
        if [[ -f "$common/commondir" ]]; then
          IFS= read -r line < "$common/commondir" || return 1
          if [[ $line == /* ]]; then common=$line; else common="$common/$line"; fi
        fi
      fi
      [[ -d "$common/singularity-flow" || -e "$common/refs/heads/sflow" ]]
      return
    fi
    [[ $directory == / ]] && return 1
    directory=${directory%/*}
    [[ -n $directory ]] || directory=/
    depth=$((depth + 1))
  done
  return 1
}
# Answered here, or the bytes go to Node as the host sent them.
quiet_hook() {
  local folder
  if [[ "$action" == boundary-guard ]]; then
    # No reader to hold the payload with: Node reads it, as with a recorded turn.
    hold_hook_input || return 1
    if hook_input_goes_to_node; then return 1; fi
    if folder=$(hook_input_cwd) && cwd_uses_sflow "$folder"; then return 1; fi
  else cat >/dev/null 2>&1 || true; fi
  printf '%s\n' '{}'; exit 0
}
# [PCR:REQ-016] Before Node starts for a prompt, the session's copy of its last prompt goes, and a plain prompt
# ends the session's earlier /sf- turn: a prompt hook that fails or times out then leaves no earlier turn's
# contract, or secret, governing this one. A prompt that may name a skill, or a stop continuation (which reads
# the turn it continues), is left to the runtime, which writes a skill turn's record again as today.
# Mirrors copilotModeFile() and recordPath() in src/copilot-repository-boundary.mjs.
clear_stale_turn() {
  local LC_ALL=C text before after id hash tool mode_dir
  hold_hook_input || return 0
  (( hook_input_large )) && return 0
  text=$hook_input
  # A stop continuation reads the turn it continues; a subagent's task shares the person's session.
  [[ $text == *SFLOW_* || $text == *'"agentId"'* || $text == *'"agent_id"'* ]] && return 0
  # macOS's bash 3.2 takes no bound past 255 in a pattern: the length is checked apart.
  [[ $text =~ \"session(Id|_id)\"[[:space:]]*:[[:space:]]*\"([A-Za-z0-9._:-]+)\" ]] || return 0
  id=${BASH_REMATCH[2]}
  (( ${#id} <= 256 )) || return 0
  mode_dir=${SINGULARITY_FLOW_COPILOT_MODE_FILE:-}
  if [[ -z "$mode_dir" && "${HOME:-}" == /* ]]; then mode_dir="$HOME/.singularity-flow/copilot-mode.json"; fi
  [[ "$mode_dir" == /* && "$mode_dir" != */ && "$mode_dir" != *'/./'* && "$mode_dir" != *'/../'* ]] || return 0
  mode_dir=${mode_dir%/*}
  for tool in "$(command -v sha256sum 2>/dev/null)" /sbin/sha256sum /usr/bin/sha256sum "$(command -v shasum 2>/dev/null)" /usr/bin/shasum; do
    [[ -n "$tool" && -x "$tool" ]] || continue
    if [[ ${tool##*/} == shasum ]]; then hash=$(printf '%s' "$id" | "$tool" -a 256 2>/dev/null)
    else hash=$(printf '%s' "$id" | "$tool" 2>/dev/null); fi
    hash=${hash%% *}
    [[ $hash =~ ^[a-f0-9]{64}$ ]] && break
    hash=''
  done
  [[ -n "$hash" ]] || return 0
  rm -f -- "$mode_dir/copilot-prompts/$hash.json" 2>/dev/null
  if [[ $text == *'"cwd":"'* ]]; then
    before=${text%%'"cwd":"'*} after=${text#*'"cwd":"'}
    text=$before${after#*\"}
  fi
  [[ $text == */sf* || $text == *skill-context* ]] && return 0
  rm -f -- "$mode_dir/copilot-boundaries/$hash.json" "$mode_dir/copilot-boundaries/$hash.mutation.json" 2>/dev/null
  return 0
}
run_hook() {
  if (( ! hook_input_held )); then exec "$@"; fi
  exec "$@" < <(printf '%s' "$hook_input")
}
if [[ "$action" == boundary-turn ]]; then clear_stale_turn; fi
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
          || run_hook "$managed_node" "$launcher_dir/hook-launcher.mjs" "$action" "$managed_cli" --cli-off-path ;;
      esac
      run_hook "$managed_node" "$launcher_dir/hook-launcher.mjs" "$action" "$managed_cli"
    fi
  fi
  # A broken managed selection must not silently fall through to a different engine/version.
  if [[ "$action" == boundary-guard ]]; then
    printf '%s\n' '{"permissionDecision":"deny","permissionDecisionReason":"SFLOW_HOOK_RUNTIME_UNAVAILABLE: The managed SFlow engine is incomplete. Repair its installation; preserve the Story.","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"SFLOW_HOOK_RUNTIME_UNAVAILABLE: The managed SFlow engine is incomplete. Repair its installation; preserve the Story."}}'
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
  printf '%s\n' '{"permissionDecision":"deny","permissionDecisionReason":"SFLOW_HOOK_RUNTIME_UNAVAILABLE: Node.js is unavailable to Copilot. Repair the SFlow installation from a human terminal, run singularity-flow plugin install, and reload VS Code. Preserve the Story; changing its ID will not repair the hook.","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"SFLOW_HOOK_RUNTIME_UNAVAILABLE: Node.js is unavailable to Copilot. Repair the SFlow installation from a human terminal, run singularity-flow plugin install, and reload VS Code. Preserve the Story; changing its ID will not repair the hook."}}'
else
  printf '%s\n' '{}'
fi
