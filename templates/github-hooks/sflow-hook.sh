#!/bin/bash
# Singularity Flow's repository hook (docs/SPEC-PCR-PLAIN-CHAT-ROUTING-v1.md, P3). Copilot runs it for this
# repository's events from .github/hooks/sflow.json with the event's action and this repository's own
# policy.plainChatEdits. `singularity-flow init` writes it; `singularity-flow doctor --repair-hooks` writes it again.
#
#   SFlow's Copilot plugin is on this machine   it guards every event, so this answers {} and each event is
#                                               handled once [PCR:REQ-031]
#   SFlow is on this machine, its plugin not    this hands the event to SFlow's own hook launcher
#   SFlow is not on this machine                an edit or a writing command is refused with the install line,
#                                               unless the setting is allow, and so is a file named to stay on a
#                                               laptop; reading stays free [PCR:REQ-032]
#
# It never fails: a host refuses a call whose hook crashed, so anything unexpected answers {}. Only the
# deliberate refusals above deny. Shell builtins only, except to read a link SFlow's install made.
set -u
action=${1:-}
setting=${2:-record}
case "$action" in
  boundary-turn|boundary-guard|boundary-after|boundary-end|agent-start|boundary-stop|boundary-failure) ;;
  *) printf '%s\n' '{}'; exit 0 ;;
esac
case "$setting" in refuse|record|allow) ;; *) setting=record ;; esac

# Read whole, then given on unchanged: a reader that stops early would lose the rest.
hook_input=$(cat 2>/dev/null; printf .) || hook_input=.
hook_input=${hook_input%.}
quiet() { printf '%s\n' '{}'; exit 0; }

# SFlow's machine state, as copilotModeFile() in src/copilot-mode.mjs places it.
state_dir() {
  local mode=${SINGULARITY_FLOW_COPILOT_MODE_FILE:-}
  if [[ -z "$mode" && "${HOME:-}" == /* ]]; then mode="$HOME/.singularity-flow/copilot-mode.json"; fi
  [[ "$mode" == /* && "$mode" != */ ]] || return 1
  printf '%s' "${mode%/*}"
}

# The plugin's own launcher leaves its folder in a marker when it runs; a Copilot CLI install is also found by its files.
plugin_installed() {
  local directory root file
  if directory=$(state_dir) && [[ -f "$directory/copilot-plugin" ]] && IFS= read -r root < "$directory/copilot-plugin" \
    && [[ "$root" == /* && -f "$root/hook-launcher.sh" ]]; then return 0; fi
  local home=${COPILOT_HOME:-}
  if [[ -z "$home" && "${HOME:-}" == /* ]]; then home="$HOME/.copilot"; fi
  [[ "$home" == /* ]] || return 1
  shopt -s nullglob
  for file in "$home"/installed-plugins/*/*/plugin.json; do
    if [[ "$(<"$file")" == *'"name": "singularity-flow"'* && -f "${file%/*}/hook-launcher.sh" ]]; then shopt -u nullglob; return 0; fi
  done
  shopt -u nullglob
  return 1
}

# SFlow's own hook launcher: the managed engine's, else the one beside the singularity-flow command.
sflow_launcher() {
  local engine=${SINGULARITY_FLOW_ENGINE_HOME:-${HOME:-}/.singularity-flow/engine} schema runtime release extra candidate target link hops root
  if [[ "$engine" == /* && -f "$engine/active" ]] && IFS='|' read -r schema runtime release extra < "$engine/active" \
    && [[ "$schema" == 1 && "$release" =~ ^[a-f0-9]{64}$ ]]; then
    candidate="$engine/releases/$release/node_modules/singularity-flow/plugin/hook-launcher.sh"
    if [[ -f "$candidate" ]]; then printf '%s' "$candidate"; return 0; fi
  fi
  # A host started from the Dock or Explorer may not have the shell's PATH: the usual install prefixes too.
  local prefix candidates=("$(command -v singularity-flow 2>/dev/null)")
  for prefix in ${SINGULARITY_FLOW_INSTALL_PREFIXES-/opt/homebrew /usr/local /opt/local}; do candidates+=("$prefix/bin/singularity-flow"); done
  for candidate in "${candidates[@]}"; do
    [[ -n "$candidate" && "$candidate" == /* && -e "$candidate" ]] || continue
    target=$candidate
    for hops in 1 2 3 4 5 6 7 8; do
      [[ -L "$target" ]] || break
      link=$(readlink "$target" 2>/dev/null) || break
      if [[ "$link" == /* ]]; then target=$link; else target="${target%/*}/$link"; fi
    done
    root=${target%/bin/*}
    if [[ "$root" != "$target" && -f "$root/plugin/hook-launcher.sh" && -f "$root/bin/singularity-flow.mjs" ]]; then
      printf '%s' "$root/plugin/hook-launcher.sh"; return 0
    fi
  done
  return 1
}

# --- Without SFlow: the payload read with builtins only. ---------------------------------------------

# Every string the payload gives a field, in order.
field_values() {
  local name=$1 rest=$hook_input pattern
  pattern="\"($name)\"[[:space:]]*:[[:space:]]*\"(([\\\\].|[^\"\\\\])*)\""
  while [[ "$rest" =~ $pattern ]]; do
    printf '%s\n' "${BASH_REMATCH[2]}"
    rest=${rest#*"${BASH_REMATCH[0]}"}
  done
}

# A tool's own name, as calls() in src/copilot-mutation-guard.mjs reads it. macOS's bash 3.2 has no lower-casing,
# so the names are compared without case instead.
tool_name() { local name=$1; name=${name##*.}; name=${name##*:}; printf '%s' "${name##*__}"; }

is_edit_tool() {
  local name status
  name=$(tool_name "$1")
  shopt -s nocasematch
  [[ "$name" =~ (patch|edit|replace|insert|write|delete|remove|create|mkdir|move|rename).*(file|directory) \
    || "$name" =~ ^(patch|edit|replace|insert|write|delete|remove|create|mkdir|move|rename|apply_patch|sflow_run)$ ]]
  status=$?
  shopt -u nocasematch
  return $status
}

is_shell_tool() {
  local name status
  name=$(tool_name "$1")
  shopt -s nocasematch
  [[ "$name" =~ ^(bash|powershell|run_in_terminal|execute|exec_command|write_stdin|write_bash)$ ]]
  status=$?
  shopt -u nocasematch
  return $status
}

# The read-only set a read-only /sf- turn runs (readOnlyShell in src/copilot-mutation-guard.mjs).
read_only_part() {
  local part=$1 sub allowed word paths=0 index=1 IFS=$' \t\n'
  local -a words
  [[ "$part" == pwd ]] && return 0
  [[ "$part" =~ ^ls(\ -[1aAlhR]+)*(\ [^-\'\"][^\ ]*)*$ ]] && return 0
  read -r -a words <<< "$part"
  [[ "${words[0]:-}" == git ]] || return 1
  while [[ "${words[index]:-}" == --no-pager || "${words[index]:-}" == -P ]]; do index=$((index + 1)); done
  sub=${words[index]:-}; index=$((index + 1))
  if [[ "$sub" == branch ]]; then [[ ${#words[@]} -eq $((index + 1)) && "${words[index]}" == --show-current ]]; return; fi
  case "$sub" in
    status) allowed='^(-s|--short|-b|--branch|--porcelain(=v[12])?|--untracked-files(=(no|normal|all))?|--ignored|-z)$' ;;
    diff) allowed='^(--stat|--numstat|--shortstat|--name-only|--name-status|--cached|--staged|--no-color|--no-renames|--check|-U[0-9]+|--unified=[0-9]+|-z)$' ;;
    log) allowed='^(--oneline|--stat|--name-only|--name-status|--no-decorate|--decorate|--graph|-[0-9]+|-n[0-9]*|--max-count=[0-9]+|[0-9]+|--format=[A-Za-z%:() -]*|--pretty=[A-Za-z%:() -]*|--no-color|-z)$' ;;
    show) allowed='^(--stat|--name-only|--name-status|--oneline|--no-patch|-s|--no-color|--format=[A-Za-z%:() -]*|--pretty=[A-Za-z%:() -]*)$' ;;
    ls-files) allowed='^(-c|--cached|-m|--modified|-o|--others|--exclude-standard|-z|-s|--stage)$' ;;
    rev-parse) allowed='^(--show-toplevel|--abbrev-ref|--verify|--short|--git-dir|--absolute-git-dir|HEAD|HEAD\^\{tree\})$' ;;
    *) return 1 ;;
  esac
  for word in "${words[@]:index}"; do
    if [[ "$word" == -- ]]; then paths=1; continue; fi
    if (( paths )) || [[ "$word" != -* ]]; then word=${word#[\'\"]}; [[ "$word" != -* ]] || return 1; continue; fi
    [[ "$word" =~ $allowed ]] || return 1
  done
  return 0
}

read_only_command() {
  local command=$1 part stripped
  # JSON's own escapes of a quote, a backslash and a slash; any other escape is a character this does not read.
  command=${command//\\\"/\"}; command=${command//\\\//\/}
  stripped=${command//\\\\/}
  [[ "$stripped" == *\\* ]] && return 1
  command=${command//\\\\/\\}
  [[ "$command" =~ [\;\|\`\$\<\>] || "$command" == *$'\n'* ]] && return 1
  command=${command//&&/$'\x1f'}
  local IFS=$'\x1f'
  for part in $command; do
    part=${part#"${part%%[![:space:]]*}"}; part=${part%"${part##*[![:space:]]}"}
    [[ -n "$part" && "$part" != *'&'* ]] || return 1
    read_only_part "$part" || return 1
  done
  return 0
}

# A file named to stay on a laptop (alwaysLocalName in src/local-config-policy.mjs), or a key file.
local_file_named() {
  local text=$hook_input rest name
  if [[ "$text" =~ \"cwd\"[[:space:]]*:[[:space:]]*\"([^\"\\]*)\" ]]; then text=${text/"${BASH_REMATCH[0]}"/}; fi
  local pattern='(^|[^A-Za-z0-9_.-])((\.env(\.[A-Za-z0-9_.-]+)?)|(application-local\.(ya?ml|properties))|([A-Za-z0-9_-][A-Za-z0-9_.-]*\.local\.(ya?ml|json|properties|toml|ini))|([A-Za-z0-9_-][A-Za-z0-9_.-]*\.(pem|key|p12|pfx|jks|keystore)))([^A-Za-z0-9_.-]|$)'
  rest=$text
  shopt -s nocasematch
  while [[ "$rest" =~ $pattern ]]; do
    name=${BASH_REMATCH[2]}
    rest=${rest#*"${BASH_REMATCH[0]}"}
    if [[ "$name" =~ ^\.env\.([A-Za-z0-9_.-]+\.)?(example|sample|template|tmpl|dist|defaults|schema)$ ]]; then continue; fi
    shopt -u nocasematch
    printf '%s' "$name"
    return 0
  done
  shopt -u nocasematch
  return 1
}

deny() {
  local reason=${1//\\/\\\\}
  reason=${reason//\"/\\\"}
  printf '{"permissionDecision":"deny","permissionDecisionReason":"%s","hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$reason" "$reason"
  exit 0
}

guard_without_sflow() {
  local name names command file what=''
  if file=$(local_file_named); then
    deny "ENVIRONMENT_FILE_PRIVATE: ${file} is named to stay on a laptop, so Copilot does not read or edit it, and Singularity Flow, which checks such files, is not installed on this machine. Keep working without its contents. Do not retry it"
  fi
  [[ "$setting" == allow ]] && quiet
  names=$(field_values 'toolName|tool_name')
  # A batch names each call; a single call's arguments may hold a "name" that is no tool.
  if [[ -z "$names" && "$hook_input" == *'"toolCalls"'* ]]; then names=$(field_values 'name'); fi
  while IFS= read -r name; do
    [[ -n "$name" ]] || continue
    if is_edit_tool "$name"; then what='this edit'; break; fi
    if is_shell_tool "$name"; then
      while IFS= read -r command; do
        # Nothing typed, or only a key such as Ctrl-C, reads or stops a shell.
        [[ -z "${command//[[:space:]]/}" || "$command" =~ ^(\\u00[01][0-9a-fA-F]|\\[ntr])+$ ]] && continue
        read_only_command "$command" || { what='this command'; break; }
      done < <(field_values 'command|cmd|script|input|chars')
      [[ -n "$what" ]] && break
    fi
  done <<< "$names"
  [[ -n "$what" ]] || quiet
  deny "SFLOW_NOT_INSTALLED: this repository sends a plain chat's changes through Singularity Flow (policy.plainChatEdits: ${setting}), which is not installed on this machine, so ${what} did not run. Reading, searching and questions stay free. To work here, install Singularity Flow (its README: Install and initialize) and run singularity-flow plugin install. Do not retry it"
}

main() {
  if plugin_installed; then quiet; fi
  local launcher
  if launcher=$(sflow_launcher); then
    exec /bin/bash "$launcher" "$action" < <(printf '%s' "$hook_input")
  fi
  [[ "$action" == boundary-guard ]] || quiet
  guard_without_sflow
}

main || true
quiet
