#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ORIGINAL_ARGUMENTS=("$@")
PUBLIC_REGISTRY="https://registry.npmjs.org/"
# Precedence: --registry, Singularity-specific environment, standard npm environment,
# then the user's/project's normal npm configuration. Keeping the standard variable in
# the chain means corporate launchers and Artifactory-managed shells need no special case.
REGISTRY_OVERRIDE="${SINGULARITY_FLOW_NPM_REGISTRY:-${NPM_CONFIG_REGISTRY:-}}"
ENABLE_COPILOT_TELEMETRY="${SINGULARITY_FLOW_COPILOT_TELEMETRY:-on}"
CLI_ONLY="off"
VSCODE_ONLY="off"
SKIP_VSCODE="off"
SKIP_COPILOT="off"
SKIP_TESTS="off"
UPDATE_CHECKOUT="on"
FROM_STAGED_ARTIFACTS="off"
FACTORY_RESET="off"
FACTORY_RESET_CONFIRMED="off"
CLEAN_REINSTALL="off"
REINSTALL_DRY_RUN="off"
REINSTALL_CONFIRM=""
REFRESH_REGISTERED_WORKSPACE_CONFIGURATION="on"
RECOVERY_WORKSPACE_CONFIGURATION_REFRESH="off"
REFRESH_VSCE_TOOLCHAIN="off"
VSIX_PATH=""
TARBALL=""
TARBALL_PATH=""
TARBALL_SHA256=""
VSIX_SHA256=""
INSTALL_ACTIVATION_JOURNAL=""
INSTALL_RECOVERY_COMMAND=""
INSTALL_ACTIVATION_OPERATION_ID=""
INSTALL_ACTIVATION_OWNER_PID=""
INSTALL_ACTIVATION_JOURNAL_REVISION=""
INSTALL_ACTIVATION_LEASE_ACTIVE="off"
INSTALL_ACTIVATION_HEARTBEAT_PID=""
CANDIDATE_CLI_EXECUTABLE=""
PREVIOUS_CLI_EXECUTABLE=""
PREVIOUS_CLI_PRESENT="off"
PREVIOUS_CLI_PATH=""
PREVIOUS_CLI_SHA256=""
PREVIOUS_CLI_ARTIFACT_VERSION=""
PREVIOUS_VSCODE_PRESENT="off"
PREVIOUS_VSIX_PATH=""
PREVIOUS_VSIX_SHA256=""
PREVIOUS_VSIX_ARTIFACT_VERSION=""
PREVIOUS_COPILOT_PRESENT="off"
PREVIOUS_TELEMETRY_ENV_TARGET=""
PREVIOUS_TELEMETRY_ENV_EXISTED="off"
PREVIOUS_TELEMETRY_ENV_SNAPSHOT=""
PREVIOUS_TELEMETRY_ENV_SHA256=""
PREVIOUS_TELEMETRY_ENV_MODE=""
PREVIOUS_TELEMETRY_PROFILE_TARGET=""
PREVIOUS_TELEMETRY_PROFILE_EXISTED="off"
PREVIOUS_TELEMETRY_PROFILE_SNAPSHOT=""
PREVIOUS_TELEMETRY_PROFILE_SHA256=""
PREVIOUS_TELEMETRY_PROFILE_MODE=""
ACTIVATION_STATUS=""
SURFACE_VSCODE_STATE="skipped"
SURFACE_COPILOT_STATE="skipped"
SURFACE_TELEMETRY_STATE="skipped"
SURFACE_CLI_STATE="skipped"
ACTIVATION_TRANSACTION_CACHE=""
COPILOT_TELEMETRY_ENV_FILE=""
COPILOT_TELEMETRY_PROFILE=""
COPILOT_TELEMETRY_SOURCE_LINE='[ -r "$HOME/.singularity-flow/copilot-otel.sh" ] && . "$HOME/.singularity-flow/copilot-otel.sh"'
PREVIOUS_MANIFEST_TARGET=""
PREVIOUS_MANIFEST_EXISTED="off"
PREVIOUS_MANIFEST_SNAPSHOT=""
PREVIOUS_MANIFEST_SHA256=""
PREVIOUS_MANIFEST_MODE=""
SURFACE_MANIFEST_STATE="pending"

# Every long-running step prints its own elapsed seconds. The last slow-install investigation had
# to be reconstructed from npm's debug logs; the transcript itself should answer "which step".
STEP_LABEL=""
STEP_STARTED=0
step_begin() { STEP_LABEL="$1"; STEP_STARTED=$SECONDS; printf '%s\n' "$1..."; }
step_end() { printf '%s\n' "  ${STEP_LABEL}: $((SECONDS - STEP_STARTED))s"; }

usage() {
  printf '%s\n' \
    'Usage: ./install.sh [--registry URL] [--no-copilot-telemetry] [--cli-only | --vscode-only | --skip-vscode | --skip-copilot] [--no-update] [--skip-tests] [--refresh-vsce-toolchain] [--no-workspace-configuration-refresh]' \
    '       ./install.sh --from-staged-artifacts' \
    '       ./install.sh --clean-reinstall [--dry-run | --confirm "REINSTALL SINGULARITY FLOW <fingerprint>"] [--registry URL] [--cli-only]' \
    '       ./install.sh --factory-reset [--yes] [--registry URL] [--cli-only]' \
    '' \
    'Pull, build, test, package, and globally install the Singularity Flow CLI,' \
    'and build the VS Code extension,' \
    'replace all previous Copilot plugin copies, and enable metadata-only' \
    'Copilot OpenTelemetry for model, token, and cost collection.' \
    '' \
    '--factory-reset previews a machine-wide fresh install. Add --yes to delete' \
    'every validated registered workspace and its clones, all Singularity local' \
    'state and managed Copilot assets, then reinstall this checkout.' \
    '' \
    '--clean-reinstall validates and packages this checkout first, then replaces' \
    'only the installed CLI, VS Code extension, Copilot plugin/direct skills, and' \
    'managed telemetry wrapper. It never reads or changes Git repositories or workspaces.' \
    '' \
    '--skip-tests keeps npm run check and all requested builds, but skips npm test' \
    'or test:cli. Use it only when this exact commit has already passed its tests.' \
    '--vscode-only builds, packages, installs, and verifies only the VS Code extension' \
    '--skip-vscode installs the CLI, Copilot plugin, skills, and telemetry without replacing the VS Code extension' \
    '--skip-copilot installs the CLI and VS Code extension without requiring or replacing standalone Copilot assets' \
    '--no-update builds the exact clean checkout currently selected instead of running git pull' \
    '--from-staged-artifacts resumes only the exact journal-bound artifacts from an interrupted activation' \
    '--refresh-vsce-toolchain reinstalls the cached VSCE packaging toolchain instead of reusing it'
}

while (($#)); do
  case "$1" in
    --registry)
      [[ $# -ge 2 ]] || { printf '%s\n' 'Error: --registry requires a URL.' >&2; exit 1; }
      REGISTRY_OVERRIDE="$2"
      shift 2
      ;;
    --registry=*)
      REGISTRY_OVERRIDE="${1#--registry=}"
      shift
      ;;
    --no-copilot-telemetry)
      ENABLE_COPILOT_TELEMETRY="off"
      shift
      ;;
    --cli-only)
      CLI_ONLY="on"
      ENABLE_COPILOT_TELEMETRY="off"
      shift
      ;;
    --vscode-only)
      VSCODE_ONLY="on"
      ENABLE_COPILOT_TELEMETRY="off"
      REFRESH_REGISTERED_WORKSPACE_CONFIGURATION="off"
      shift
      ;;
    --skip-vscode)
      SKIP_VSCODE="on"
      shift
      ;;
    --skip-copilot)
      SKIP_COPILOT="on"
      ENABLE_COPILOT_TELEMETRY="off"
      shift
      ;;
    --no-update)
      UPDATE_CHECKOUT="off"
      shift
      ;;
    --from-staged-artifacts)
      FROM_STAGED_ARTIFACTS="on"
      shift
      ;;
    --refresh-vsce-toolchain)
      REFRESH_VSCE_TOOLCHAIN="on"
      shift
      ;;
    --skip-tests)
      SKIP_TESTS="on"
      shift
      ;;
    --no-workspace-workflow-sync|--no-workspace-configuration-refresh)
      REFRESH_REGISTERED_WORKSPACE_CONFIGURATION="off"
      shift
      ;;
    --factory-reset)
      FACTORY_RESET="on"
      shift
      ;;
    --clean-reinstall)
      CLEAN_REINSTALL="on"
      shift
      ;;
    --dry-run)
      REINSTALL_DRY_RUN="on"
      shift
      ;;
    --confirm)
      [[ $# -ge 2 ]] || { printf '%s\n' 'Error: --confirm requires the exact reinstall confirmation.' >&2; exit 1; }
      REINSTALL_CONFIRM="$2"
      shift 2
      ;;
    --confirm=*)
      REINSTALL_CONFIRM="${1#--confirm=}"
      shift
      ;;
    --yes)
      FACTORY_RESET_CONFIRMED="on"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'Error: unknown option: %s\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ "$FROM_STAGED_ARTIFACTS" == "on" ]]; then
  if [[ "${#ORIGINAL_ARGUMENTS[@]}" -ne 1 || "${ORIGINAL_ARGUMENTS[0]}" != "--from-staged-artifacts" ]]; then
    printf '%s\n' 'Error: --from-staged-artifacts cannot be combined with any other installer option.' >&2
    exit 1
  fi
  # Recovery takes every mode and registry value from the exact journal. Shell preferences and
  # registry environment variables cannot change the reviewed activation request.
  ENABLE_COPILOT_TELEMETRY="off"
  UPDATE_CHECKOUT="off"
  REFRESH_REGISTERED_WORKSPACE_CONFIGURATION="off"
fi

case "$ENABLE_COPILOT_TELEMETRY" in
  on|off) ;;
  *) printf '%s\n' 'Error: SINGULARITY_FLOW_COPILOT_TELEMETRY must be on or off.' >&2; exit 1 ;;
esac

if [[ "$FACTORY_RESET_CONFIRMED" == "on" && "$FACTORY_RESET" != "on" ]]; then
  printf '%s\n' 'Error: --yes is valid only with --factory-reset.' >&2
  exit 1
fi
if [[ "$CLI_ONLY" == "on" && "$SKIP_VSCODE" == "on" ]]; then
  printf '%s\n' 'Error: --cli-only already skips VS Code; pass only one of these options.' >&2
  exit 1
fi
if [[ "$VSCODE_ONLY" == "on" && ( "$CLI_ONLY" == "on" || "$SKIP_VSCODE" == "on" || "$SKIP_COPILOT" == "on" ) ]]; then
  printf '%s\n' 'Error: --vscode-only is mutually exclusive with --cli-only, --skip-vscode, and --skip-copilot.' >&2
  exit 1
fi
if [[ "$CLI_ONLY" == "on" && "$SKIP_COPILOT" == "on" ]]; then
  printf '%s\n' 'Error: --cli-only already skips Copilot; pass only one of these options.' >&2
  exit 1
fi
if [[ "$CLEAN_REINSTALL" == "on" && ( "$SKIP_COPILOT" == "on" || "$UPDATE_CHECKOUT" == "off" ) ]]; then
  printf '%s\n' 'Error: --skip-copilot and --no-update apply to normal source installs; --clean-reinstall already avoids Git and replaces its declared complete surface.' >&2
  exit 1
fi
if [[ "$SKIP_VSCODE" == "on" && ( "$FACTORY_RESET" == "on" || "$CLEAN_REINSTALL" == "on" ) ]]; then
  printf '%s\n' 'Error: --skip-vscode is supported only by a normal install; reset and clean-reinstall replace their complete declared surface.' >&2
  exit 1
fi
if [[ "$VSCODE_ONLY" == "on" && ( "$FACTORY_RESET" == "on" || "$CLEAN_REINSTALL" == "on" ) ]]; then
  printf '%s\n' 'Error: --vscode-only is supported only by a normal install; reset and clean-reinstall replace their complete declared surface.' >&2
  exit 1
fi

if [[ "$SKIP_TESTS" == "on" && ( "$FACTORY_RESET" == "on" || "$CLEAN_REINSTALL" == "on" ) ]]; then
  printf '%s\n' 'Error: --skip-tests is valid only for a normal non-destructive install.' >&2
  exit 1
fi

if [[ "$CLEAN_REINSTALL" != "on" && ( "$REINSTALL_DRY_RUN" == "on" || -n "$REINSTALL_CONFIRM" ) ]]; then
  printf '%s\n' 'Error: --dry-run and --confirm are valid only with --clean-reinstall.' >&2
  exit 1
fi
if [[ "$CLEAN_REINSTALL" == "on" && "$FACTORY_RESET" == "on" ]]; then
  printf '%s\n' 'Error: --clean-reinstall and --factory-reset are separate operations and cannot be combined.' >&2
  exit 1
fi
if [[ "$CLEAN_REINSTALL" == "on" && "$REINSTALL_DRY_RUN" == "on" && -n "$REINSTALL_CONFIRM" ]]; then
  printf '%s\n' 'Error: --dry-run does not accept --confirm. Review the preview first.' >&2
  exit 1
fi

# Clean reinstall deliberately delegates before the normal installer asks Git for a checkout
# status or performs its pull. The Node planner validates source files and packaged artifacts,
# but neither this path nor its implementation executes Git or discovers workspace repositories.
if [[ "$CLEAN_REINSTALL" == "on" ]]; then
  command -v node >/dev/null 2>&1 || { printf '%s\n' 'Error: required command not found: node' >&2; exit 1; }
  NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
  [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || { printf '%s\n' 'Error: could not determine the Node.js version.' >&2; exit 1; }
  (( NODE_MAJOR >= 20 )) || { printf 'Error: Node.js 20 or newer is required; found %s.\n' "$(node --version 2>/dev/null || printf unknown)" >&2; exit 1; }
  REINSTALL_ARGS=(reinstall --checkout "$PROJECT_DIR")
  [[ -n "$REGISTRY_OVERRIDE" ]] && REINSTALL_ARGS+=(--registry "$REGISTRY_OVERRIDE")
  [[ "$CLI_ONLY" == "on" ]] && REINSTALL_ARGS+=(--cli-only)
  [[ "$ENABLE_COPILOT_TELEMETRY" == "off" ]] && REINSTALL_ARGS+=(--no-copilot-telemetry)
  if [[ -n "$REINSTALL_CONFIRM" ]]; then
    REINSTALL_ARGS+=(--confirm "$REINSTALL_CONFIRM")
  else
    REINSTALL_ARGS+=(--dry-run)
  fi
  exec node "$PROJECT_DIR/bin/singularity-flow.mjs" "${REINSTALL_ARGS[@]}"
fi

if [[ "$FROM_STAGED_ARTIFACTS" == "on" ]]; then
  REQUIRED_COMMANDS=(node)
else
  REQUIRED_COMMANDS=(git node npm)
  if [[ "$VSCODE_ONLY" == "on" ]]; then REQUIRED_COMMANDS+=(code); fi
  if [[ "$CLI_ONLY" != "on" && "$VSCODE_ONLY" != "on" && "$SKIP_COPILOT" != "on" ]]; then REQUIRED_COMMANDS+=(copilot); fi
fi
for command in "${REQUIRED_COMMANDS[@]}"; do
  command -v "$command" >/dev/null 2>&1 || { printf 'Error: required command not found: %s\n' "$command" >&2; exit 1; }
done
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || { printf '%s\n' 'Error: could not determine the Node.js version.' >&2; exit 1; }
(( NODE_MAJOR >= 20 )) || { printf 'Error: Node.js 20 or newer is required; found %s.\n' "$(node --version 2>/dev/null || printf unknown)" >&2; exit 1; }
# Git Bash can expose an MSYS pseudo-PID through $$, while Node's process.kill uses the native
# Windows process namespace. Ask a Node child for its native parent PID so every helper observes
# and records the same cross-platform shell identity.
INSTALL_ACTIVATION_OWNER_PID="$(node -p 'process.ppid' 2>/dev/null || true)"
[[ "$INSTALL_ACTIVATION_OWNER_PID" =~ ^[1-9][0-9]*$ ]] || {
  printf '%s\n' 'Error: could not determine the installer shell native process ID.' >&2
  exit 1
}

normalize_registry() {
  node -e '
    const value = process.argv[1];
    let registry;
    try { registry = new URL(value); }
    catch { throw new Error(`Invalid npm registry URL: ${value}`); }
    if (!['"'"'http:'"'"', '"'"'https:'"'"'].includes(registry.protocol)) throw new Error('"'"'The npm registry must use http:// or https://.'"'"');
    if (registry.username || registry.password) throw new Error('"'"'Do not place registry credentials in the URL; configure authentication in .npmrc.'"'"');
    if (registry.search || registry.hash) throw new Error('"'"'The npm registry URL cannot contain a query string or fragment.'"'"');
    if (!registry.pathname.endsWith('"'"'/'"'"')) registry.pathname += '"'"'/'"'"';
    process.stdout.write(registry.toString());
  ' "$1"
}

choose_registry() {
  local configured choice custom
  configured="$(npm config get registry 2>/dev/null || true)"
  if [[ ! "$configured" =~ ^https?:// ]]; then configured="$PUBLIC_REGISTRY"; fi
  configured="$(normalize_registry "$configured")"

  if [[ -n "$REGISTRY_OVERRIDE" ]]; then
    normalize_registry "$REGISTRY_OVERRIDE"
    return
  fi
  if [[ ! -t 0 || ! -t 1 ]]; then
    printf '%s' "$configured"
    return
  fi

  printf '\nChoose npm registry:\n' >&2
  printf '  1. Configured registry — %s\n' "$configured" >&2
  printf '  2. Public npm registry — %s\n' "$PUBLIC_REGISTRY" >&2
  printf '  3. Custom company registry / Artifactory\n' >&2
  read -r -p 'Enter 1-3 [1]: ' choice
  choice="${choice:-1}"
  case "$choice" in
    1) printf '%s' "$configured" ;;
    2) printf '%s' "$PUBLIC_REGISTRY" ;;
    3)
      read -r -p 'Registry URL: ' custom
      normalize_registry "$custom"
      ;;
    *) printf '%s\n' 'Error: registry selection must be 1, 2, or 3.' >&2; exit 1 ;;
  esac
}

resolve_copilot_telemetry_paths() {
  COPILOT_TELEMETRY_ENV_FILE="$HOME/.singularity-flow/copilot-otel.sh"
  COPILOT_TELEMETRY_PROFILE=""
  local shell_name
  shell_name="${SHELL:-}"
  shell_name="${shell_name##*/}"
  case "$shell_name" in
    zsh) COPILOT_TELEMETRY_PROFILE="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [[ -f "$HOME/.bash_profile" ]]; then
        COPILOT_TELEMETRY_PROFILE="$HOME/.bash_profile"
      else
        COPILOT_TELEMETRY_PROFILE="$HOME/.bashrc"
      fi
      ;;
  esac
}

install_copilot_telemetry() {
  if [[ "$ENABLE_COPILOT_TELEMETRY" == "off" ]]; then
    printf '%s\n' 'Copilot OpenTelemetry setup: skipped.'
    return
  fi

  local config_dir env_file profile source_line temp_file
  config_dir="$HOME/.singularity-flow"
  env_file="$COPILOT_TELEMETRY_ENV_FILE"
  profile="$COPILOT_TELEMETRY_PROFILE"
  source_line="$COPILOT_TELEMETRY_SOURCE_LINE"

  mkdir -p "$config_dir"
  chmod 700 "$config_dir"
  temp_file="$(mktemp "$config_dir/copilot-otel.sh.XXXXXX")"
  printf '%s\n' \
    '# Managed by the Singularity Flow installer.' \
    "# Never shadows the user's copilot executable. SFlow provisions only processes it launches." \
    'sflow_copilot() {' \
    '  command singularity-flow copilot "$@"' \
    '}' > "$temp_file"
  chmod 600 "$temp_file"
  mv "$temp_file" "$env_file"

  if [[ -z "$profile" ]]; then
    printf 'Copilot OpenTelemetry environment installed at %s\n' "$env_file"
    printf 'Add this to your shell startup file: %s\n' "$source_line"
    printf '%s\n' 'Use sflow copilot for consented, story-scoped local usage capture.'
    return
  fi

  mkdir -p "$(dirname "$profile")"
  touch "$profile"
  if ! grep -Fqx "$source_line" "$profile"; then
    printf '\n%s\n%s\n' '# Singularity Flow: Copilot model/token/cost telemetry' "$source_line" >> "$profile"
  fi
  # Make telemetry active for the remainder of this installer too.
  . "$env_file"
  printf 'SFlow Copilot launcher helper: enabled in %s\n' "$profile"
  printf '%s\n' 'Use sflow copilot for consented, story-scoped local usage capture.'
  printf '%s\n' 'Prompt and response content capture remains disabled.'
}

# A normal product install is also the explicit configuration-maintenance boundary. The installed
# command discovers every registered workspace repository, refreshes its independent sflow/config
# authority in an isolated clone, and mirrors the exact approved configuration to its orphan state
# branch. Active Story branches and dirty working trees are never read or changed. A protected
# configuration authority retains a review branch and makes this installer fail visibly instead of
# silently losing the candidate. Clean reinstall delegates before this function and keeps its strict
# no-workspace promise.
refresh_registered_workspace_configurations() {
  if [[ "$REFRESH_REGISTERED_WORKSPACE_CONFIGURATION" == "off" ]]; then
    printf '%s\n' 'Registered-workspace configuration refresh: skipped by request.'
    return
  fi
  singularity-flow workspace refresh-configuration
}

INSTALL_ARTIFACT_HELPER="$PROJECT_DIR/scripts/install-staged-artifacts.mjs"
INSTALL_MANIFEST_DIR="$HOME/.singularity-flow/installations"
mkdir -p "$INSTALL_MANIFEST_DIR"
chmod 700 "$INSTALL_MANIFEST_DIR"
INSTALL_ACTIVATION_JOURNAL="$INSTALL_MANIFEST_DIR/activation-current.json"
[[ -f "$INSTALL_ARTIFACT_HELPER" ]] || {
  printf 'Error: staged-artifact validator is missing: %s\n' "$INSTALL_ARTIFACT_HELPER" >&2
  exit 1
}
cd "$PROJECT_DIR"

# Product activation is a single machine-local transaction. The lease directory is created with
# mkdir by the validator and records this shell PID. A concurrent installer is refused, while a
# lease whose recorded process is no longer alive is reclaimed through an atomic rename. Every
# journal mutation additionally carries the operation ID and expected revision.
acquire_activation_lease() {
  local mode="$1" output
  output="$(node "$INSTALL_ARTIFACT_HELPER" lease-acquire \
    --journal "$INSTALL_ACTIVATION_JOURNAL" \
    --checkout "$PROJECT_DIR" \
    --mode "$mode" \
    --owner-pid "$INSTALL_ACTIVATION_OWNER_PID")"
  local fields=()
  while IFS= read -r field; do fields+=("$field"); done <<< "$output"
  if [[ "${#fields[@]}" -ne 2 || "${fields[1]}" != "$INSTALL_ACTIVATION_OWNER_PID" ]]; then
    printf '%s\n' 'Error: staged-artifact validator returned an invalid activation lease.' >&2
    return 1
  fi
  INSTALL_ACTIVATION_OPERATION_ID="${fields[0]}"
  INSTALL_ACTIVATION_LEASE_ACTIVE="on"
  trap release_activation_lease EXIT
  node "$INSTALL_ARTIFACT_HELPER" lease-heartbeat-loop \
    --journal "$INSTALL_ACTIVATION_JOURNAL" \
    --operation-id "$INSTALL_ACTIVATION_OPERATION_ID" \
    --owner-pid "$INSTALL_ACTIVATION_OWNER_PID" >/dev/null 2>&1 &
  INSTALL_ACTIVATION_HEARTBEAT_PID="$!"
}

release_activation_lease() {
  [[ "$INSTALL_ACTIVATION_LEASE_ACTIVE" == "on" ]] || return 0
  if [[ -n "$INSTALL_ACTIVATION_HEARTBEAT_PID" ]]; then
    kill "$INSTALL_ACTIVATION_HEARTBEAT_PID" >/dev/null 2>&1 || true
    wait "$INSTALL_ACTIVATION_HEARTBEAT_PID" 2>/dev/null || true
    INSTALL_ACTIVATION_HEARTBEAT_PID=""
  fi
  if node "$INSTALL_ARTIFACT_HELPER" lease-release \
    --journal "$INSTALL_ACTIVATION_JOURNAL" \
    --operation-id "$INSTALL_ACTIVATION_OPERATION_ID" \
    --owner-pid "$INSTALL_ACTIVATION_OWNER_PID"; then
    INSTALL_ACTIVATION_LEASE_ACTIVE="off"
    return 0
  fi
  printf 'Error: activation lease for operation %s could not be released safely.\n' \
    "$INSTALL_ACTIVATION_OPERATION_ID" >&2
  return 1
}

load_activation_record() {
  local output fields=()
  output="$(node "$INSTALL_ARTIFACT_HELPER" resume \
    --journal "$INSTALL_ACTIVATION_JOURNAL" \
    --checkout "$PROJECT_DIR" \
    --installer "$PROJECT_DIR/install.sh" \
    --operation-id "$INSTALL_ACTIVATION_OPERATION_ID" \
    --owner-pid "$INSTALL_ACTIVATION_OWNER_PID")"
  while IFS= read -r field; do fields+=("$field"); done <<< "$output"
  if [[ "${#fields[@]}" -ne 45 ]]; then
    printf 'Error: staged-artifact validator returned %s recovery fields; expected 45.\n' "${#fields[@]}" >&2
    return 1
  fi
  REGISTRY="${fields[0]}"
  PACKAGE_VERSION="${fields[1]}"
  TARBALL_PATH="${fields[2]}"
  VSIX_PATH="${fields[3]}"
  [[ "$TARBALL_PATH" == "-" ]] && TARBALL_PATH=""
  [[ "$VSIX_PATH" == "-" ]] && VSIX_PATH=""
  CLI_ONLY="${fields[4]}"
  VSCODE_ONLY="${fields[5]}"
  SKIP_VSCODE="${fields[6]}"
  SKIP_COPILOT="${fields[7]}"
  ENABLE_COPILOT_TELEMETRY="${fields[8]}"
  RECOVERY_WORKSPACE_CONFIGURATION_REFRESH="${fields[9]}"
  REFRESH_REGISTERED_WORKSPACE_CONFIGURATION="$RECOVERY_WORKSPACE_CONFIGURATION_REFRESH"
  printf -v INSTALL_RECOVERY_COMMAND '%q ' "$PROJECT_DIR/install.sh" --from-staged-artifacts
  if [[ "${fields[10]}" != "${INSTALL_RECOVERY_COMMAND% }" ]]; then
    printf '%s\n' 'Error: activation journal recovery command does not match this checkout.' >&2
    return 1
  fi
  TARBALL_SHA256="${fields[11]}"
  [[ "$TARBALL_SHA256" == "-" ]] && TARBALL_SHA256=""
  if [[ "${fields[12]}" != "$INSTALL_ACTIVATION_OPERATION_ID" ]]; then
    printf '%s\n' 'Error: activation lease and recovery journal operation IDs differ.' >&2
    return 1
  fi
  INSTALL_ACTIVATION_JOURNAL_REVISION="${fields[13]}"
  ACTIVATION_STATUS="${fields[14]}"
  PREVIOUS_CLI_PRESENT="${fields[15]}"
  PREVIOUS_CLI_PATH="${fields[16]}"
  PREVIOUS_CLI_SHA256="${fields[17]}"
  PREVIOUS_CLI_ARTIFACT_VERSION="${fields[18]}"
  PREVIOUS_VSCODE_PRESENT="${fields[19]}"
  PREVIOUS_VSIX_PATH="${fields[20]}"
  PREVIOUS_VSIX_SHA256="${fields[21]}"
  PREVIOUS_VSIX_ARTIFACT_VERSION="${fields[22]}"
  PREVIOUS_COPILOT_PRESENT="${fields[23]}"
  PREVIOUS_TELEMETRY_ENV_TARGET="${fields[24]}"
  PREVIOUS_TELEMETRY_ENV_EXISTED="${fields[25]}"
  PREVIOUS_TELEMETRY_ENV_SNAPSHOT="${fields[26]}"
  PREVIOUS_TELEMETRY_ENV_SHA256="${fields[27]}"
  PREVIOUS_TELEMETRY_ENV_MODE="${fields[28]}"
  PREVIOUS_TELEMETRY_PROFILE_TARGET="${fields[29]}"
  PREVIOUS_TELEMETRY_PROFILE_EXISTED="${fields[30]}"
  PREVIOUS_TELEMETRY_PROFILE_SNAPSHOT="${fields[31]}"
  PREVIOUS_TELEMETRY_PROFILE_SHA256="${fields[32]}"
  PREVIOUS_TELEMETRY_PROFILE_MODE="${fields[33]}"
  PREVIOUS_MANIFEST_TARGET="${fields[34]}"
  PREVIOUS_MANIFEST_EXISTED="${fields[35]}"
  PREVIOUS_MANIFEST_SNAPSHOT="${fields[36]}"
  PREVIOUS_MANIFEST_SHA256="${fields[37]}"
  PREVIOUS_MANIFEST_MODE="${fields[38]}"
  SURFACE_VSCODE_STATE="${fields[39]}"
  SURFACE_COPILOT_STATE="${fields[40]}"
  SURFACE_TELEMETRY_STATE="${fields[41]}"
  SURFACE_CLI_STATE="${fields[42]}"
  SURFACE_MANIFEST_STATE="${fields[43]}"
  VSIX_SHA256="${fields[44]}"
  [[ "$VSIX_SHA256" == "-" ]] && VSIX_SHA256=""
  for variable in PREVIOUS_CLI_PATH PREVIOUS_CLI_SHA256 PREVIOUS_CLI_ARTIFACT_VERSION \
    PREVIOUS_VSIX_PATH PREVIOUS_VSIX_SHA256 PREVIOUS_VSIX_ARTIFACT_VERSION \
    PREVIOUS_TELEMETRY_ENV_TARGET PREVIOUS_TELEMETRY_ENV_SNAPSHOT PREVIOUS_TELEMETRY_ENV_SHA256 \
    PREVIOUS_TELEMETRY_ENV_MODE PREVIOUS_TELEMETRY_PROFILE_TARGET PREVIOUS_TELEMETRY_PROFILE_SNAPSHOT \
    PREVIOUS_TELEMETRY_PROFILE_SHA256 PREVIOUS_TELEMETRY_PROFILE_MODE PREVIOUS_MANIFEST_TARGET \
    PREVIOUS_MANIFEST_SNAPSHOT PREVIOUS_MANIFEST_SHA256 PREVIOUS_MANIFEST_MODE; do
    [[ "${!variable}" == "-" ]] && printf -v "$variable" '%s' ''
  done
  return 0
}

if [[ "$FROM_STAGED_ARTIFACTS" == "on" ]]; then
  acquire_activation_lease resume
  load_activation_record
  if [[ -n "$TARBALL_PATH" ]]; then
    command -v npm >/dev/null 2>&1 || { printf '%s\n' 'Error: required command not found: npm' >&2; exit 1; }
  fi
  if [[ "$VSCODE_ONLY" == "on" ]]; then
    command -v code >/dev/null 2>&1 || { printf '%s\n' 'Error: required command not found: code' >&2; exit 1; }
  fi
  if [[ "$CLI_ONLY" != "on" && "$VSCODE_ONLY" != "on" && "$SKIP_COPILOT" != "on" ]]; then
    command -v copilot >/dev/null 2>&1 || { printf '%s\n' 'Error: required command not found: copilot' >&2; exit 1; }
  fi
  export NPM_CONFIG_REGISTRY="$REGISTRY"
  printf 'Resuming exact staged Singularity Flow %s artifacts; source preparation and packaging are skipped.\n' "$PACKAGE_VERSION"
else
if [[ "$FACTORY_RESET" == "on" ]]; then
  printf '%s\n' 'Validating the complete fresh-install deletion boundary...'
  node scripts/fresh-install-reset.mjs
  if [[ "$FACTORY_RESET_CONFIRMED" != "on" ]]; then
    printf '%s\n' 'Preview only: nothing was deleted. Review the paths above, then add --yes.'
    exit 0
  fi
  printf '%s\n' 'Removing previous managed Copilot plugin copies...'
  if [[ "$CLI_ONLY" != "on" ]] && command -v singularity-flow >/dev/null 2>&1; then
    singularity-flow plugin uninstall >/dev/null 2>&1 || true
  fi
  if command -v code >/dev/null 2>&1; then
    code --uninstall-extension singularityflow.singularity-flow-vscode >/dev/null 2>&1 || true
  fi
  node scripts/fresh-install-reset.mjs --yes
  printf '%s\n' 'Validated workspace clones and Singularity machine state removed.'
fi

if [[ -n "$(git status --porcelain)" ]]; then
  printf '%s\n' 'Error: the checkout has uncommitted changes outside the validated factory-reset boundary. Commit or stash them before installation.' >&2
  git status --short >&2
  exit 1
fi

if [[ "$UPDATE_CHECKOUT" == "on" ]]; then
  printf '%s\n' 'Updating the current tracked branch...'
  git pull --ff-only
else
  printf '%s\n' 'Using the exact current clean checkout (--no-update); no Git fetch or pull was run.'
fi

# Office-safe distribution boundary: this installer must never provision Git-host automation.
# `npm run check` repeats this invariant, while this early guard fails before dependency install or
# packaging if a hosted workflow is accidentally reintroduced into the tracked checkout.
HOSTED_AUTOMATION_FILES="$(git ls-files -- '.github/workflows/*' 'examples/singularity-flow-validation.yml')"
if [[ -n "$HOSTED_AUTOMATION_FILES" ]]; then
  printf '%s\n' 'Error: hosted GitHub workflow assets are unsupported by this installer:' >&2
  printf '%s\n' "$HOSTED_AUTOMATION_FILES" >&2
  exit 1
fi

REGISTRY="$(choose_registry)"
printf 'Using npm registry: %s\n' "$REGISTRY"

# Make the selected registry authoritative for every npm process in this installation,
# including npm run lifecycle subprocesses and packaging helpers. Individual install
# commands retain --registry as an auditable defence in depth.
export NPM_CONFIG_REGISTRY="$REGISTRY"

# Source preparation has selected its exact checkout and registry. Serialize the remaining build,
# staging, and active-surface replacement so two installers cannot mutate shared package outputs or
# the activation journal concurrently.
acquire_activation_lease create

step_begin 'Installing locked dependencies'
if [[ "$CLI_ONLY" == "on" ]]; then
  npm ci --workspaces=false --registry="$REGISTRY"
else
  npm ci --registry="$REGISTRY"
fi
step_end

step_begin 'Compiling and validating the project'
npm run check
step_end
if [[ "$CLI_ONLY" == "on" ]]; then
  if [[ "$SKIP_TESTS" == "on" ]]; then
    printf '%s\n' 'WARNING: CLI tests skipped by request; run npm run test:cli locally before distributing this build.' >&2
  else
    step_begin 'Running the CLI test suite'
    npm run test:cli
    step_end
  fi
else
  step_begin 'Building the VS Code extension'
  if [[ "$SKIP_VSCODE" != "on" ]]; then npm run vscode:build; fi
  step_end
  if [[ "$SKIP_TESTS" == "on" ]]; then
    printf '%s\n' 'WARNING: full test suite skipped by request; run npm test locally before distributing this build.' >&2
  else
    step_begin 'Running the full test suite'
    npm test
    step_end
  fi
fi

# The VSCE toolchain cache honours this for the vscode:package step below.
if [[ "$REFRESH_VSCE_TOOLCHAIN" == "on" ]]; then
  export SINGULARITY_FLOW_REFRESH_VSCE_TOOLCHAIN=1
fi

# Stamp which source revision this tarball came from, so the installed CLI can say so later.
#
# After the tests deliberately: the suite runs against the committed placeholder, so a stamp that
# changes on every run can never make a test flaky. Restored by the trap below however this exits —
# a failure between here and `npm pack` would otherwise leave the tree dirty and the *next* run of
# this script would refuse it at the uncommitted-changes guard above.
#
# A bare test copy contains only install.sh, so it has nothing to stamp. A real checkout containing
# build-info.mjs must also contain a working stamper: silently installing the placeholder would make
# the packaged CLI falsely call itself a development checkout.
BUILD_INFO_BACKUP=''
restore_build_info() {
  if [[ -n "$BUILD_INFO_BACKUP" && -f "$BUILD_INFO_BACKUP" ]]; then
    cp "$BUILD_INFO_BACKUP" "$PROJECT_DIR/src/build-info.mjs"
    rm -f "$BUILD_INFO_BACKUP"
  fi
}
restore_build_info_and_release_activation_lease() {
  local cleanup_status=0
  restore_build_info || cleanup_status=$?
  release_activation_lease || cleanup_status=$?
  return "$cleanup_status"
}
if [[ "$VSCODE_ONLY" != "on" ]]; then
  if [[ -f "$PROJECT_DIR/scripts/stamp-build-info.mjs" ]]; then
    printf '%s\n' 'Stamping build provenance...'
    BUILD_INFO_BACKUP="$(mktemp "${TMPDIR:-/tmp}/sflow-build-info.XXXXXX")"
    cp "$PROJECT_DIR/src/build-info.mjs" "$BUILD_INFO_BACKUP"
    trap restore_build_info_and_release_activation_lease EXIT
    node "$PROJECT_DIR/scripts/stamp-build-info.mjs"
  elif [[ -f "$PROJECT_DIR/src/build-info.mjs" ]]; then
    printf '%s\n' 'Error: build provenance stamper is missing; refusing to package an unidentified build.' >&2
    exit 1
  fi

  printf '%s\n' 'Creating the distribution tarball...'
  PACK_OUTPUT="$(npm pack --json)"
  restore_build_info
  trap release_activation_lease EXIT
  TARBALL="$(PACK_OUTPUT="$PACK_OUTPUT" node -e '
    const result = JSON.parse(process.env.PACK_OUTPUT);
    if (!result?.[0]?.filename) throw new Error('"'"'npm pack did not report a tarball filename.'"'"');
    process.stdout.write(result[0].filename);
  ')"
  TARBALL_PATH="$PROJECT_DIR/$TARBALL"
fi

# Build every requested artifact before replacing any active surface. A packaging failure now leaves
# the existing CLI, extension, plugin, and telemetry configuration untouched.
if [[ "$CLI_ONLY" != "on" && "$SKIP_VSCODE" != "on" ]]; then
  VSIX_MANIFEST="$PROJECT_DIR/apps/vscode/package.json"
  VSIX_BUILD_MARKER=''
  if [[ -f "$VSIX_MANIFEST" ]]; then
    VSIX_PATH="$(node -e '
      const manifest = require(process.argv[1]);
      process.stdout.write(require("node:path").join(process.argv[2], `${manifest.name}-${manifest.version}.vsix`));
    ' "$VSIX_MANIFEST" "$PROJECT_DIR/apps/vscode")"
    rm -f "$VSIX_PATH"
  else
    # A copied standalone installer has no manifest from which to derive the filename. Bind its
    # result to this packaging invocation by accepting exactly one archive newer than the marker;
    # pre-existing sibling archives can never be selected.
    VSIX_BUILD_MARKER="$(mktemp "${TMPDIR:-/tmp}/sflow-vsix-build.XXXXXX")"
    VSIX_PATH=''
  fi
  step_begin 'Packaging the VS Code extension'
  npm run vscode:package
  step_end
  if [[ -n "$VSIX_BUILD_MARKER" ]]; then
    VSIX_CANDIDATES=()
    while IFS= read -r candidate; do VSIX_CANDIDATES+=("$candidate"); done < <(
      find "$PROJECT_DIR/apps/vscode" -maxdepth 1 -type f -name '*.vsix' -newer "$VSIX_BUILD_MARKER" -print 2>/dev/null
    )
    rm -f "$VSIX_BUILD_MARKER"
    if [[ "${#VSIX_CANDIDATES[@]}" -ne 1 ]]; then
      printf 'Error: VS Code packaging produced %s fresh archives; expected exactly one.\n' "${#VSIX_CANDIDATES[@]}" >&2
      exit 1
    fi
    VSIX_PATH="${VSIX_CANDIDATES[0]}"
  fi
  [[ -f "$VSIX_PATH" ]] || { printf 'Error: VS Code packaging did not produce expected archive: %s\n' "$VSIX_PATH" >&2; exit 1; }
fi

# Validate the version join before the first active surface changes. Packaging each surface first
# is not enough if their manifests disagree: a successful sequence would still activate an
# incoherent product.
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = process.argv[1];
  const manifests = ["package.json", "plugin/plugin.json", "apps/vscode/package.json"]
    .map((file) => path.join(root, file)).filter((file) => fs.existsSync(file))
    .map((file) => JSON.parse(fs.readFileSync(file, "utf8")));
  const versions = [...new Set(manifests.map((manifest) => manifest.version))];
  if (versions.length > 1) throw new Error(`Product surface versions differ: ${versions.join(", ")}`);
' "$PROJECT_DIR"
PACKAGE_VERSION="$(node -p 'require(process.argv[1]).version' "$PROJECT_DIR/package.json")"

  PREVIOUS_CLI_VERSION='-'
  if [[ "$VSCODE_ONLY" != "on" ]] && command -v singularity-flow >/dev/null 2>&1; then
    if ! PREVIOUS_CLI_VERSION="$(singularity-flow --version 2>/dev/null)" || [[ -z "$PREVIOUS_CLI_VERSION" ]]; then
      printf '%s\n' 'Error: the existing managed CLI identity could not be read; refusing activation before mutation.' >&2
      exit 1
    fi
  fi
  PREVIOUS_VSCODE_VERSION='-'
  if [[ "$CLI_ONLY" != "on" && "$SKIP_VSCODE" != "on" ]] && command -v code >/dev/null 2>&1; then
    if ! PREVIOUS_VSCODE_EXTENSIONS="$(code --list-extensions --show-versions 2>/dev/null)"; then
      printf '%s\n' 'Error: VS Code extension state could not be read; refusing activation before mutation.' >&2
      exit 1
    fi
    PREVIOUS_VSCODE_EXTENSIONS="${PREVIOUS_VSCODE_EXTENSIONS//$'\r'/}"
    while IFS= read -r extension; do
      if [[ "$extension" == singularityflow.singularity-flow-vscode@* ]]; then
        PREVIOUS_VSCODE_VERSION="${extension#*@}"
        break
      fi
    done <<< "$PREVIOUS_VSCODE_EXTENSIONS"
  fi
  PREVIOUS_COPILOT_PRESENT="off"
  if [[ "$CLI_ONLY" != "on" && "$VSCODE_ONLY" != "on" && "$SKIP_COPILOT" != "on" ]]; then
    if ! PREVIOUS_COPILOT_LIST="$(copilot plugin list 2>&1)"; then
      printf '%s\n' 'Error: Copilot plugin state could not be read; refusing activation before mutation.' >&2
      exit 1
    fi
    if grep -Eq '(^|[[:space:]])singularity-flow(@|[[:space:]]|$)' <<< "$PREVIOUS_COPILOT_LIST"; then
      PREVIOUS_COPILOT_PRESENT="on"
    fi
  fi
  COPILOT_TELEMETRY_ENV_FILE=""
  COPILOT_TELEMETRY_PROFILE=""
  if [[ "$CLI_ONLY" != "on" && "$VSCODE_ONLY" != "on" && "$SKIP_COPILOT" != "on" \
    && "$ENABLE_COPILOT_TELEMETRY" == "on" ]]; then
    resolve_copilot_telemetry_paths
  fi
  printf -v INSTALL_RECOVERY_COMMAND '%q ' "$PROJECT_DIR/install.sh" --from-staged-artifacts
  RETAINED_ARTIFACT_OUTPUT="$(node "$INSTALL_ARTIFACT_HELPER" create \
    --journal "$INSTALL_ACTIVATION_JOURNAL" \
    --checkout "$PROJECT_DIR" \
    --registry "$REGISTRY" \
    --version "$PACKAGE_VERSION" \
    --tarball "${TARBALL_PATH:--}" \
    --vsix "${VSIX_PATH:--}" \
    --installer "$PROJECT_DIR/install.sh" \
    --operation-id "$INSTALL_ACTIVATION_OPERATION_ID" \
    --owner-pid "$INSTALL_ACTIVATION_OWNER_PID" \
    --recovery-command "${INSTALL_RECOVERY_COMMAND% }" \
    --previous-cli "$PREVIOUS_CLI_VERSION" \
    --previous-vscode "$PREVIOUS_VSCODE_VERSION" \
    --previous-copilot "$PREVIOUS_COPILOT_PRESENT" \
    --current-manifest "$INSTALL_MANIFEST_DIR/current.json" \
    --telemetry-env-file "${COPILOT_TELEMETRY_ENV_FILE:--}" \
    --telemetry-profile "${COPILOT_TELEMETRY_PROFILE:--}" \
    --cli-only "$CLI_ONLY" \
    --vscode-only "$VSCODE_ONLY" \
    --skip-vscode "$SKIP_VSCODE" \
    --skip-copilot "$SKIP_COPILOT" \
    --telemetry "$ENABLE_COPILOT_TELEMETRY" \
    --workspace-refresh "$REFRESH_REGISTERED_WORKSPACE_CONFIGURATION")"
  RETAINED_ARTIFACT_FIELDS=()
  while IFS= read -r field; do RETAINED_ARTIFACT_FIELDS+=("$field"); done <<< "$RETAINED_ARTIFACT_OUTPUT"
  if [[ "${#RETAINED_ARTIFACT_FIELDS[@]}" -ne 6 ]]; then
    printf '%s\n' 'Error: staged-artifact validator returned invalid retained-artifact bindings.' >&2
    exit 1
  fi
  TARBALL_PATH="${RETAINED_ARTIFACT_FIELDS[0]}"
  VSIX_PATH="${RETAINED_ARTIFACT_FIELDS[1]}"
  TARBALL_SHA256="${RETAINED_ARTIFACT_FIELDS[2]}"
  VSIX_SHA256="${RETAINED_ARTIFACT_FIELDS[3]}"
  if [[ "${RETAINED_ARTIFACT_FIELDS[4]}" != "$INSTALL_ACTIVATION_OPERATION_ID" ]]; then
    printf '%s\n' 'Error: activation lease and new journal operation IDs differ.' >&2
    exit 1
  fi
  INSTALL_ACTIVATION_JOURNAL_REVISION="${RETAINED_ARTIFACT_FIELDS[5]}"
  [[ "$TARBALL_PATH" == "-" ]] && TARBALL_PATH=""
  [[ "$VSIX_PATH" == "-" ]] && VSIX_PATH=""
  [[ "$TARBALL_SHA256" == "-" ]] && TARBALL_SHA256=""
  [[ "$VSIX_SHA256" == "-" ]] && VSIX_SHA256=""
  load_activation_record
fi

# The journal is a compare-and-swap state machine. Each external surface enters `applying` before
# its CLI is invoked and reaches `applied` only after verification. A crash therefore leaves an
# unambiguous rollback obligation instead of an optimistic completion list.
write_activation_journal() {
  local status="$1" surface="$2" completed="${3:--}" skipped="${4:--}" failure_step="${5:--}"
  local transition_surface="${6:--}" transition_state="${7:--}" rollback_failure="${8:--}" revision
  if ! revision="$(node "$INSTALL_ARTIFACT_HELPER" update \
    --journal "$INSTALL_ACTIVATION_JOURNAL" \
    --operation-id "$INSTALL_ACTIVATION_OPERATION_ID" \
    --owner-pid "$INSTALL_ACTIVATION_OWNER_PID" \
    --expected-revision "$INSTALL_ACTIVATION_JOURNAL_REVISION" \
    --status "$status" \
    --surface "$surface" \
    --completed "$completed" \
    --skipped "$skipped" \
    --failure-step "$failure_step" \
    --transition-surface "$transition_surface" \
    --transition-state "$transition_state" \
    --rollback-failure "$rollback_failure")"; then
    return 1
  fi
  INSTALL_ACTIVATION_JOURNAL_REVISION="$revision"
  ACTIVATION_STATUS="$status"
}

set_surface_state() {
  local surface="$1" state="$2" status="$3" label="$4" completed="${5:--}" skipped="${6:--}"
  write_activation_journal "$status" "$label" "$completed" "$skipped" - "$surface" "$state"
  case "$surface" in
    vscode) SURFACE_VSCODE_STATE="$state" ;;
    copilot) SURFACE_COPILOT_STATE="$state" ;;
    telemetry) SURFACE_TELEMETRY_STATE="$state" ;;
    cli) SURFACE_CLI_STATE="$state" ;;
    manifest) SURFACE_MANIFEST_STATE="$state" ;;
  esac
}

surface_state() {
  case "$1" in
    vscode) printf '%s' "$SURFACE_VSCODE_STATE" ;;
    copilot) printf '%s' "$SURFACE_COPILOT_STATE" ;;
    telemetry) printf '%s' "$SURFACE_TELEMETRY_STATE" ;;
    cli) printf '%s' "$SURFACE_CLI_STATE" ;;
    manifest) printf '%s' "$SURFACE_MANIFEST_STATE" ;;
  esac
}

sha256_file() {
  node -e 'const fs=require("node:fs"),c=require("node:crypto"); process.stdout.write(`sha256:${c.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex")}`)' "$1"
}

restore_file_binding() {
  local target="$1" existed="$2" snapshot="$3" digest="$4" mode="$5" label="$6" temporary
  [[ -n "$target" ]] || return 0
  if [[ "$existed" == "on" ]]; then
    [[ -f "$snapshot" && ! -L "$snapshot" && "$(sha256_file "$snapshot")" == "$digest" ]] || {
      printf 'Rollback material for %s failed digest validation.\n' "$label" >&2
      return 1
    }
    mkdir -p "$(dirname "$target")"
    temporary="$(mktemp "$(dirname "$target")/.sflow-rollback.XXXXXX")"
    if ! cp "$snapshot" "$temporary" || ! chmod "$mode" "$temporary" || ! mv "$temporary" "$target"; then
      rm -f -- "$temporary"
      return 1
    fi
    [[ -f "$target" && ! -L "$target" && "$(sha256_file "$target")" == "$digest" ]]
  else
    if [[ -d "$target" && ! -L "$target" ]]; then return 1; fi
    rm -f -- "$target"
    [[ ! -e "$target" && ! -L "$target" ]]
  fi
}

vscode_extension_version() {
  local output extension
  output="$(code --list-extensions --show-versions)" || return 2
  output="${output//$'\r'/}"
  while IFS= read -r extension; do
    if [[ "$extension" == singularityflow.singularity-flow-vscode@* ]]; then
      printf '%s' "${extension#*@}"
      return 0
    fi
  done <<< "$output"
  return 1
}

copilot_plugin_present() {
  local output
  output="$(copilot plugin list 2>&1)" || return 2
  grep -Eq '(^|[[:space:]])singularity-flow(@|[[:space:]]|$)' <<< "$output"
}

preflight_private_cli() {
  local tarball="$1" digest="$2" version="$3" role="$4" target temporary executable observed
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || return 1
  target="$INSTALL_MANIFEST_DIR/transactions/$INSTALL_ACTIVATION_OPERATION_ID/private-cli-$role"
  temporary="$(mktemp -d "$INSTALL_MANIFEST_DIR/transactions/$INSTALL_ACTIVATION_OPERATION_ID/.private-cli-${role}.XXXXXX")"
  if ! npm install --prefix "$temporary" --ignore-scripts --no-audit --no-fund --package-lock=false \
    --cache "$ACTIVATION_TRANSACTION_CACHE" "$tarball" --registry="$REGISTRY"; then
    rm -rf -- "$temporary"
    return 1
  fi
  executable="$(node "$INSTALL_ARTIFACT_HELPER" verify-cli --prefix "$temporary" --version "$version")" || {
    rm -rf -- "$temporary"
    return 1
  }
  observed="$(node "$executable" --version)" || { rm -rf -- "$temporary"; return 1; }
  [[ "$observed" == "$version" ]] || { rm -rf -- "$temporary"; return 1; }
  [[ ! -e "$target" && ! -L "$target" ]] || rm -rf -- "$target"
  mv "$temporary" "$target"
  executable="$target/node_modules/singularity-flow/bin/singularity-flow.mjs"
  if [[ "$role" == "candidate" ]]; then
    CANDIDATE_CLI_EXECUTABLE="$executable"
  else
    PREVIOUS_CLI_EXECUTABLE="$executable"
  fi
}

restore_vscode_surface() {
  local observed status
  command -v code >/dev/null 2>&1 || return 1
  if [[ "$PREVIOUS_VSCODE_PRESENT" == "on" ]]; then
    code --install-extension "$PREVIOUS_VSIX_PATH" --force || return 1
    observed="$(vscode_extension_version)" || return 1
    [[ "$observed" == "$PREVIOUS_VSIX_ARTIFACT_VERSION" ]]
  else
    code --uninstall-extension singularityflow.singularity-flow-vscode >/dev/null 2>&1 || true
    if vscode_extension_version >/dev/null; then return 1; else status=$?; fi
    [[ "$status" -eq 1 ]]
  fi
}

restore_copilot_surface() {
  local status
  command -v copilot >/dev/null 2>&1 || return 1
  node "$CANDIDATE_CLI_EXECUTABLE" plugin uninstall >/dev/null 2>&1 || true
  if [[ "$PREVIOUS_COPILOT_PRESENT" == "on" ]]; then
    [[ -n "$PREVIOUS_CLI_EXECUTABLE" ]] || return 1
    node "$PREVIOUS_CLI_EXECUTABLE" plugin install || return 1
    copilot_plugin_present
  else
    if copilot_plugin_present; then return 1; else status=$?; fi
    [[ "$status" -eq 1 ]]
  fi
}

restore_telemetry_surface() {
  restore_file_binding "$PREVIOUS_TELEMETRY_ENV_TARGET" "$PREVIOUS_TELEMETRY_ENV_EXISTED" \
    "$PREVIOUS_TELEMETRY_ENV_SNAPSHOT" "$PREVIOUS_TELEMETRY_ENV_SHA256" \
    "$PREVIOUS_TELEMETRY_ENV_MODE" telemetry-env || return 1
  restore_file_binding "$PREVIOUS_TELEMETRY_PROFILE_TARGET" "$PREVIOUS_TELEMETRY_PROFILE_EXISTED" \
    "$PREVIOUS_TELEMETRY_PROFILE_SNAPSHOT" "$PREVIOUS_TELEMETRY_PROFILE_SHA256" \
    "$PREVIOUS_TELEMETRY_PROFILE_MODE" telemetry-profile
}

restore_cli_surface() {
  local observed
  if [[ "$PREVIOUS_CLI_PRESENT" == "on" ]]; then
    npm install --global "$PREVIOUS_CLI_PATH" --cache "$ACTIVATION_TRANSACTION_CACHE" --registry="$REGISTRY" || return 1
    hash -r
    command -v singularity-flow >/dev/null 2>&1 || return 1
    observed="$(singularity-flow --version)" || return 1
    [[ "$observed" == "$PREVIOUS_CLI_ARTIFACT_VERSION" ]]
  else
    npm uninstall --global singularity-flow --cache "$ACTIVATION_TRANSACTION_CACHE" --registry="$REGISTRY" >/dev/null 2>&1 || true
    hash -r
    ! command -v singularity-flow >/dev/null 2>&1
  fi
}

restore_manifest_surface() {
  restore_file_binding "$PREVIOUS_MANIFEST_TARGET" "$PREVIOUS_MANIFEST_EXISTED" \
    "$PREVIOUS_MANIFEST_SNAPSHOT" "$PREVIOUS_MANIFEST_SHA256" "$PREVIOUS_MANIFEST_MODE" current-manifest
}

rollback_activation() {
  local reason="${1:-activation-failure}" rollback_failed="off" surface state
  write_activation_journal rolling-back rollback-started - - "$reason" || {
    printf '%s\n' 'Error: activation rollback could not acquire its journal transition.' >&2
    return 1
  }
  for surface in manifest cli telemetry copilot vscode; do
    state="$(surface_state "$surface")"
    case "$state" in applying|applied|restoring) ;; *) continue ;; esac
    if ! set_surface_state "$surface" restoring rolling-back "$surface-restore-started"; then
      rollback_failed="on"
      continue
    fi
    if "restore_${surface}_surface"; then
      if ! set_surface_state "$surface" restored rolling-back "$surface-restored"; then
        rollback_failed="on"
      fi
    else
      rollback_failed="on"
      write_activation_journal rolling-back "$surface-restore-failed" - - "$reason" - - "$surface" || true
    fi
  done
  if [[ "$rollback_failed" == "on" ]]; then
    write_activation_journal rollback-failed rollback-failed - - "$reason" || true
    return 1
  fi
  write_activation_journal rolled-back rollback-complete - - "$reason"
}

activation_failed() {
  local exit_code=$? reason="${STEP_LABEL:-activation}"
  [[ $# -lt 1 ]] || exit_code="$1"
  trap - ERR INT TERM HUP
  # `complete` is the activation commit point. A signal can arrive in the few instructions between
  # persisting that state and removing these traps; at that point compensation would be both
  # invalid and harmful because every surface and the exact receipt already committed together.
  if [[ "$ACTIVATION_STATUS" == "complete" ]]; then
    printf '\nInstallation activation committed before %s; product surfaces remain coherent.\n' "$reason" >&2
    exit "$exit_code"
  fi
  if rollback_activation "$reason"; then
    printf '\nError: product activation stopped at %s and every touched surface was restored.\n' "$reason" >&2
    printf 'Retry the same exact candidate: %s\n' "$INSTALL_RECOVERY_COMMAND" >&2
  else
    printf '\nCRITICAL: product activation stopped at %s and exact rollback was not verified.\n' "$reason" >&2
    printf 'Do not start another install. Repair from journal: %s\n' "$INSTALL_ACTIVATION_JOURNAL" >&2
    printf 'Retry exact recovery only: %s\n' "$INSTALL_RECOVERY_COMMAND" >&2
  fi
  exit "$exit_code"
}

activation_signal() {
  local signal="$1" code="$2"
  STEP_LABEL="signal-$signal"
  activation_failed "$code"
}

ACTIVATION_TRANSACTION_CACHE="$INSTALL_MANIFEST_DIR/transactions/$INSTALL_ACTIVATION_OPERATION_ID/npm-cache"
mkdir -p "$ACTIVATION_TRANSACTION_CACHE"
chmod 700 "$ACTIVATION_TRANSACTION_CACHE"
COPILOT_TELEMETRY_ENV_FILE="$PREVIOUS_TELEMETRY_ENV_TARGET"
COPILOT_TELEMETRY_PROFILE="$PREVIOUS_TELEMETRY_PROFILE_TARGET"

# Rebuild both executable CLIs from journal-verified retained tarballs before any product mutation.
# This refuses an installation whose rollback receipt exists only as a version string.
if [[ -n "$TARBALL_PATH" ]]; then
  step_begin 'Verifying the candidate CLI from its retained tarball'
  preflight_private_cli "$TARBALL_PATH" "$TARBALL_SHA256" "$PACKAGE_VERSION" candidate
  step_end
fi
if [[ "$PREVIOUS_CLI_PRESENT" == "on" || "$PREVIOUS_COPILOT_PRESENT" == "on" ]]; then
  step_begin 'Verifying the prior CLI rollback artifact'
  preflight_private_cli "$PREVIOUS_CLI_PATH" "$PREVIOUS_CLI_SHA256" \
    "$PREVIOUS_CLI_ARTIFACT_VERSION" previous
  step_end
fi

trap activation_failed ERR
trap 'activation_signal INT 130' INT
trap 'activation_signal TERM 143' TERM
trap 'activation_signal HUP 129' HUP

# An interrupted process cannot run its traps. Recovery first finishes compensation from the
# recorded per-surface states, then resets the verified rolled-back candidate for a clean retry.
if [[ "$FROM_STAGED_ARTIFACTS" == "on" ]]; then
  case "$ACTIVATION_STATUS" in
    activating|rolling-back|rollback-failed)
      STEP_LABEL='Recovering the interrupted activation'
      rollback_activation interrupted-recovery || activation_failed 1
      ;;
  esac
  if [[ "$ACTIVATION_STATUS" == "rolled-back" ]]; then
    INSTALL_ACTIVATION_JOURNAL_REVISION="$(node "$INSTALL_ARTIFACT_HELPER" reset \
      --journal "$INSTALL_ACTIVATION_JOURNAL" \
      --operation-id "$INSTALL_ACTIVATION_OPERATION_ID" \
      --owner-pid "$INSTALL_ACTIVATION_OWNER_PID" \
      --expected-revision "$INSTALL_ACTIVATION_JOURNAL_REVISION")"
    load_activation_record
  fi
fi
write_activation_journal activating activation-started

# Active-surface order deliberately keeps the globally callable CLI last. Copilot installation uses
# the private candidate executable, so no earlier step depends on a half-committed global CLI.
if [[ "$SURFACE_VSCODE_STATE" == "pending" ]]; then
  if command -v code >/dev/null 2>&1; then
    step_begin 'Installing the VS Code extension'
    set_surface_state vscode applying activating vscode-started
    code --install-extension "$VSIX_PATH" --force
    INSTALLED_VSCODE_VERSION="$(vscode_extension_version)" || activation_failed 1
    if [[ "$INSTALLED_VSCODE_VERSION" != "$PACKAGE_VERSION" ]]; then
      printf 'Error: VS Code did not report singularityflow.singularity-flow-vscode@%s after installation.\n' "$PACKAGE_VERSION" >&2
      activation_failed 1
    fi
    set_surface_state vscode applied activating vscode vscode
    step_end
  else
    printf 'VS Code CLI not found; install the extension later with: code --install-extension %s --force\n' "$VSIX_PATH"
    set_surface_state vscode skipped activating vscode-skipped - code-unavailable
  fi
fi

if [[ "$SURFACE_COPILOT_STATE" == "pending" ]]; then
  step_begin 'Replacing previous Copilot plugin copies'
  set_surface_state copilot applying activating copilot-plugin-started
  node "$CANDIDATE_CLI_EXECUTABLE" plugin install
  copilot_plugin_present || activation_failed 1
  set_surface_state copilot applied activating copilot-plugin copilot-plugin
  step_end
fi

if [[ "$SURFACE_TELEMETRY_STATE" == "pending" ]]; then
  step_begin 'Configuring Copilot model, token, and cost telemetry'
  set_surface_state telemetry applying activating telemetry-started
  install_copilot_telemetry
  [[ -f "$COPILOT_TELEMETRY_ENV_FILE" && ! -L "$COPILOT_TELEMETRY_ENV_FILE" ]] || activation_failed 1
  if [[ -n "$COPILOT_TELEMETRY_PROFILE" ]]; then
    grep -Fqx "$COPILOT_TELEMETRY_SOURCE_LINE" "$COPILOT_TELEMETRY_PROFILE" || activation_failed 1
  fi
  set_surface_state telemetry applied activating telemetry telemetry
  step_end
fi

if [[ "$SURFACE_CLI_STATE" == "pending" ]]; then
  printf '%s\n' 'Replacing the globally installed CLI last...'
  step_begin 'Installing the CLI globally'
  set_surface_state cli applying activating cli-started
  npm install --global "$TARBALL_PATH" --cache "$ACTIVATION_TRANSACTION_CACHE" --registry="$REGISTRY"
  hash -r
  command -v singularity-flow >/dev/null 2>&1 || {
    printf '%s\n' 'Error: npm completed but singularity-flow is not available on PATH.' >&2
    activation_failed 1
  }
  INSTALLED_CLI_VERSION="$(singularity-flow --version)"
  if [[ "$INSTALLED_CLI_VERSION" != "$PACKAGE_VERSION" ]]; then
    printf 'Error: installed CLI reports %s; expected %s.\n' "${INSTALLED_CLI_VERSION:-no version}" "$PACKAGE_VERSION" >&2
    activation_failed 1
  fi
  set_surface_state cli applied activating cli cli
  step_end
fi

# current.json is itself journaled as the final transaction surface. Its prior bytes and mode were
# retained before activation, so a signal in this narrow commit window remains compensable.
STEP_LABEL='Committing the installation receipt'
set_surface_state manifest applying activating manifest-started
INSTALL_MANIFEST_TEMP="$(mktemp "$INSTALL_MANIFEST_DIR/current.json.XXXXXX")"
node -e '
  const fs = require("node:fs");
  const [file, version, checkout, journalFile, workspaceRefresh, previousManifestFile, previousManifestExisted] = process.argv.slice(1);
  const journal = JSON.parse(fs.readFileSync(journalFile, "utf8"));
  const previousManifest = previousManifestExisted === "on"
    ? JSON.parse(fs.readFileSync(previousManifestFile, "utf8"))
    : null;
  const priorArtifacts = previousManifest?.schemaVersion === 2
    ? previousManifest.artifacts ?? {}
    : { tarball: previousManifest?.tarball ?? null, vsix: previousManifest?.vsix ?? null };
  const priorSurfaces = previousManifest?.surfaces ?? {};
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 2,
    status: journal.skippedSurfaces.length ? "complete-with-skips" : "complete",
    version,
    checkout,
    artifacts: {
      tarball: journal.surfaceStates.cli === "applied"
        ? journal.artifacts.tarball : journal.previous.cli ?? priorArtifacts.tarball ?? null,
      vsix: journal.surfaceStates.vscode === "applied"
        ? journal.artifacts.vsix : journal.previous.vscode ?? priorArtifacts.vsix ?? null
    },
    surfaces: {
      cli: journal.surfaceStates.cli === "applied" || journal.previous.cliPresent || priorSurfaces.cli === true,
      vscode: journal.surfaceStates.vscode === "applied" || journal.previous.vscodePresent || priorSurfaces.vscode === true,
      copilot: journal.surfaceStates.copilot === "applied" || journal.previous.copilotPresent || priorSurfaces.copilot === true,
      telemetry: journal.surfaceStates.telemetry === "applied" || Boolean(journal.previous.telemetry) || priorSurfaces.telemetry === true,
      manifest: true
    },
    workspaceRefresh,
    activation: { journal: journalFile, operationId: journal.operationId },
    installedAt: new Date().toISOString()
  }, null, 2) + "\n", {mode: 0o600});
' "$INSTALL_MANIFEST_TEMP" "$PACKAGE_VERSION" "$PROJECT_DIR" "$INSTALL_ACTIVATION_JOURNAL" \
  "$([[ "$RECOVERY_WORKSPACE_CONFIGURATION_REFRESH" == "on" ]] && printf pending || printf skipped)" \
  "${PREVIOUS_MANIFEST_SNAPSHOT:--}" "$PREVIOUS_MANIFEST_EXISTED"
mv "$INSTALL_MANIFEST_TEMP" "$PREVIOUS_MANIFEST_TARGET"
set_surface_state manifest applied activating manifest manifest
write_activation_journal complete complete
trap - ERR INT TERM HUP

# Workspace Git refresh is deliberately outside product activation. If it is slow, interrupted, or
# rejected, current.json remains a coherent installed-product receipt with an explicit pending flag.
WORKSPACE_REFRESH_STATUS="skipped"
if [[ "$RECOVERY_WORKSPACE_CONFIGURATION_REFRESH" == "on" ]]; then
  step_begin 'Refreshing approved configuration in every registered workspace repository'
  if refresh_registered_workspace_configurations; then
    WORKSPACE_REFRESH_STATUS="complete"
  else
    WORKSPACE_REFRESH_STATUS="pending"
    printf '%s\n' 'WARNING: product activation is complete, but workspace configuration refresh is pending.' >&2
    printf '%s\n' 'Retry exactly: singularity-flow workspace refresh-configuration' >&2
  fi
  step_end
fi
INSTALL_MANIFEST_TEMP="$(mktemp "$INSTALL_MANIFEST_DIR/current.json.XXXXXX")"
if node -e '
  const fs = require("node:fs");
  const [source, target, status] = process.argv.slice(1);
  const manifest = JSON.parse(fs.readFileSync(source, "utf8"));
  manifest.workspaceRefresh = status;
  fs.writeFileSync(target, JSON.stringify(manifest, null, 2) + "\n", {mode: 0o600});
' "$PREVIOUS_MANIFEST_TARGET" "$INSTALL_MANIFEST_TEMP" "$WORKSPACE_REFRESH_STATUS"; then
  mv "$INSTALL_MANIFEST_TEMP" "$PREVIOUS_MANIFEST_TARGET"
else
  rm -f -- "$INSTALL_MANIFEST_TEMP"
  printf '%s\n' 'WARNING: installation is complete, but its workspace-refresh receipt could not be updated.' >&2
fi
release_activation_lease
trap - EXIT

if [[ "$VSCODE_ONLY" == "on" ]]; then
  printf '\nInstalled Singularity Flow VS Code extension %s\n' "$PACKAGE_VERSION"
else
  printf '\nInstalled Singularity Flow %s\n' "$PACKAGE_VERSION"
fi
# Named explicitly, because the CLI on PATH is a *copy* and not a link to this checkout: editing
# these sources changes nothing about the installed command until install.sh runs again.
printf 'Built from checkout: %s\n' "$PROJECT_DIR"
if [[ -n "$TARBALL_PATH" ]]; then printf 'Distribution tarball: %s\n' "$TARBALL_PATH"; fi
printf 'Registry: %s\n' "$REGISTRY"
if [[ "$VSCODE_ONLY" == "on" ]]; then
  printf '%s\n' 'VS Code-only installation complete; the global CLI, standalone Copilot assets, telemetry, and workspace configuration were not changed.'
elif [[ "$CLI_ONLY" != "on" && "$SKIP_COPILOT" != "on" ]]; then
  copilot plugin list
  printf '%s\n' 'Open a new terminal, then start a new Copilot session to load the refreshed skills and telemetry environment.'
elif [[ "$SKIP_COPILOT" == "on" ]]; then
  printf '%s\n' 'CLI and VS Code installation complete; standalone Copilot plugin/skills and telemetry setup were skipped.'
else
  printf '%s\n' 'CLI-only installation complete; VS Code was not built and Copilot plugin/telemetry setup was skipped.'
fi
