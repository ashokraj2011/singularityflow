#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository_root="$(cd "${script_dir}/.." && pwd)"
dry_run=false
stop_only=false
grace_seconds=8

usage() {
  cat <<'EOF'
Usage: ./scripts/start-desktop.sh [--dry-run] [--stop-only] [--grace-seconds N]

Stops other Singularity Flow desktop process trees, then starts this checkout's
desktop application. It does not stop Copilot, Event Horizon, IDEs, or
singularity-flow CLI generation commands.

Options:
  --dry-run           Show the processes that would be stopped; do not stop or start anything.
  --stop-only         Stop existing Singularity Flow desktop applications and exit.
  --grace-seconds N   Wait N seconds before force-stopping survivors (default: 8).
  -h, --help          Show this help.
EOF
}

while (($#)); do
  case "$1" in
    --dry-run) dry_run=true ;;
    --stop-only) stop_only=true ;;
    --grace-seconds)
      shift
      [[ $# -gt 0 ]] || { echo "Error: --grace-seconds requires a value." >&2; exit 2; }
      grace_seconds="$1"
      [[ "${grace_seconds}" =~ ^[0-9]+$ ]] || { echo "Error: --grace-seconds must be a non-negative integer." >&2; exit 2; }
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Error: unknown option '$1'." >&2; usage >&2; exit 2 ;;
  esac
  shift
done

self_pid="$$"
declare -a selected_pids=()

contains_pid() {
  local candidate="$1"
  local existing
  for existing in "${selected_pids[@]:-}"; do
    [[ "${existing}" == "${candidate}" ]] && return 0
  done
  return 1
}

add_pid() {
  local candidate="$1"
  [[ -n "${candidate}" && "${candidate}" != "${self_pid}" && "${candidate}" != "1" ]] || return 0
  contains_pid "${candidate}" || selected_pids+=("${candidate}")
}

process_line() {
  ps -p "$1" -o pid=,ppid=,command= 2>/dev/null | sed -e 's/^[[:space:]]*//' | head -n 1
}

is_desktop_marker() {
  local command="$1"
  [[ "${command}" == *"npm run desktop:dev"* \
    || "${command}" == *"npm run dev --workspace singularity-flow-desktop"* \
    || "${command}" == *"/Singularity Flow.app/Contents/MacOS/Singularity Flow"* \
    || "${command}" == *"singularity-flow-desktop.exe"* \
    || ("${command}" == *"--user-data-dir="* && "${command}" == *"singularity-flow-desktop"*) ]]
}

is_desktop_ancestor() {
  local command="$1"
  [[ "${command}" == *"npm run desktop:dev"* \
    || "${command}" == *"npm run dev"* \
    || "${command}" == *"node electron/dev.mjs"* \
    || "${command}" == *"/node_modules/electron/"*"Electron ."* \
    || "${command}" == *"/Singularity Flow.app/Contents/MacOS/Singularity Flow"* \
    || "${command}" == *"singularity-flow-desktop.exe"* ]]
}

# Seed the process set from product-specific command-line markers. Electron
# helpers always carry the product user-data directory, even when the main
# process was launched from an arbitrarily named scratch checkout.
while read -r pid ppid command; do
  [[ -n "${pid:-}" ]] || continue
  if is_desktop_marker "${command:-}"; then
    add_pid "${pid}"
    parent="${ppid}"
    while [[ -n "${parent}" && "${parent}" != "1" ]]; do
      line="$(process_line "${parent}")"
      [[ -n "${line}" ]] || break
      read -r ancestor_pid ancestor_parent ancestor_command <<<"${line}"
      is_desktop_ancestor "${ancestor_command:-}" || break
      add_pid "${ancestor_pid}"
      parent="${ancestor_parent}"
    done
  fi
done < <(ps -axo pid=,ppid=,command=)

# Include every descendant so Vite, Electron helpers, and npm wrappers terminate
# together instead of leaving an occupied port or a hidden stale process.
changed=true
while ${changed}; do
  changed=false
  while read -r pid ppid _command; do
    [[ -n "${pid:-}" ]] || continue
    if contains_pid "${ppid:-}" && ! contains_pid "${pid}"; then
      add_pid "${pid}"
      changed=true
    fi
  done < <(ps -axo pid=,ppid=,command=)
done

if ((${#selected_pids[@]})); then
  echo "Singularity Flow desktop processes:"
  for pid in "${selected_pids[@]}"; do
    line="$(process_line "${pid}")"
    [[ -n "${line}" ]] && echo "  ${line}"
  done
else
  echo "No other Singularity Flow desktop application is running."
fi

if ${dry_run}; then
  echo "Dry run: nothing was stopped or started."
  exit 0
fi

if ((${#selected_pids[@]})); then
  kill -TERM "${selected_pids[@]}" 2>/dev/null || true
  deadline=$((SECONDS + grace_seconds))
  while ((SECONDS < deadline)); do
    survivors=()
    for pid in "${selected_pids[@]}"; do
      kill -0 "${pid}" 2>/dev/null && survivors+=("${pid}")
    done
    ((${#survivors[@]} == 0)) && break
    sleep 1
  done

  survivors=()
  for pid in "${selected_pids[@]}"; do
    kill -0 "${pid}" 2>/dev/null && survivors+=("${pid}")
  done
  if ((${#survivors[@]})); then
    echo "Force-stopping ${#survivors[@]} unresponsive Singularity Flow process(es)."
    kill -KILL "${survivors[@]}" 2>/dev/null || true
  fi
  echo "Stopped previous Singularity Flow desktop application(s)."
fi

${stop_only} && exit 0

echo "Starting Singularity Flow from ${repository_root}"
cd "${repository_root}"
exec npm run desktop:dev
