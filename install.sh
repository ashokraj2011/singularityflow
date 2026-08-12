#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_REGISTRY="https://registry.npmjs.org/"
# Precedence: --registry, Singularity-specific environment, standard npm environment,
# then the user's/project's normal npm configuration. Keeping the standard variable in
# the chain means corporate launchers and Artifactory-managed shells need no special case.
REGISTRY_OVERRIDE="${SINGULARITY_FLOW_NPM_REGISTRY:-${NPM_CONFIG_REGISTRY:-}}"
ENABLE_COPILOT_TELEMETRY="${SINGULARITY_FLOW_COPILOT_TELEMETRY:-on}"
CLI_ONLY="off"
FACTORY_RESET="off"
FACTORY_RESET_CONFIRMED="off"
CLEAN_REINSTALL="off"
REINSTALL_DRY_RUN="off"
REINSTALL_CONFIRM=""

usage() {
  printf '%s\n' \
    'Usage: ./install.sh [--registry URL] [--no-copilot-telemetry] [--cli-only]' \
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
    'managed telemetry wrapper. It never reads or changes Git repositories or workspaces.'
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

case "$ENABLE_COPILOT_TELEMETRY" in
  on|off) ;;
  *) printf '%s\n' 'Error: SINGULARITY_FLOW_COPILOT_TELEMETRY must be on or off.' >&2; exit 1 ;;
esac

if [[ "$FACTORY_RESET_CONFIRMED" == "on" && "$FACTORY_RESET" != "on" ]]; then
  printf '%s\n' 'Error: --yes is valid only with --factory-reset.' >&2
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

REQUIRED_COMMANDS=(git node npm)
if [[ "$CLI_ONLY" != "on" ]]; then REQUIRED_COMMANDS+=(copilot); fi
for command in "${REQUIRED_COMMANDS[@]}"; do
  command -v "$command" >/dev/null 2>&1 || { printf 'Error: required command not found: %s\n' "$command" >&2; exit 1; }
done

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

install_copilot_telemetry() {
  if [[ "$ENABLE_COPILOT_TELEMETRY" == "off" ]]; then
    printf '%s\n' 'Copilot OpenTelemetry setup: skipped.'
    return
  fi

  local config_dir env_file shell_name profile source_line temp_file
  config_dir="$HOME/.singularity-flow"
  env_file="$config_dir/copilot-otel.sh"
  source_line='[ -r "$HOME/.singularity-flow/copilot-otel.sh" ] && . "$HOME/.singularity-flow/copilot-otel.sh"'

  mkdir -p "$config_dir"
  chmod 700 "$config_dir"
  temp_file="$(mktemp "$config_dir/copilot-otel.sh.XXXXXX")"
  printf '%s\n' \
    '# Managed by the Singularity Flow installer.' \
    '# Records model, token, timing, and cost metadata. Prompt/response content remains disabled.' \
    '# Raw traces stay inside each repository Git directory and are never committed.' \
    'copilot() {' \
    '  local sflow_git_dir sflow_telemetry_file' \
    '  sflow_git_dir="$(command git rev-parse --absolute-git-dir 2>/dev/null || true)"' \
    '  if [ -n "$sflow_git_dir" ] && [ -z "${COPILOT_OTEL_FILE_EXPORTER_PATH:-}" ] && [ -z "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] && [ -z "${COPILOT_OTEL_ENABLED:-}" ]; then' \
    '    sflow_telemetry_file="$sflow_git_dir/singularity-flow/copilot-otel.jsonl"' \
    '    command mkdir -p "$sflow_git_dir/singularity-flow"' \
    '    command touch "$sflow_telemetry_file"' \
    '    command chmod 600 "$sflow_telemetry_file"' \
    '    COPILOT_OTEL_ENABLED=true COPILOT_OTEL_EXPORTER_TYPE=file COPILOT_OTEL_FILE_EXPORTER_PATH="$sflow_telemetry_file" command copilot "$@"' \
    '  else' \
    '    command copilot "$@"' \
    '  fi' \
    '}' > "$temp_file"
  chmod 600 "$temp_file"
  mv "$temp_file" "$env_file"

  shell_name="${SHELL:-}"
  shell_name="${shell_name##*/}"
  case "$shell_name" in
    zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [[ -f "$HOME/.bash_profile" ]]; then profile="$HOME/.bash_profile"; else profile="$HOME/.bashrc"; fi
      ;;
    *)
      printf 'Copilot OpenTelemetry environment installed at %s\n' "$env_file"
      printf 'Add this to your shell startup file: %s\n' "$source_line"
      printf '%s\n' 'Raw telemetry output: <repository-git-dir>/singularity-flow/copilot-otel.jsonl'
      return
      ;;
  esac

  mkdir -p "$(dirname "$profile")"
  touch "$profile"
  if ! grep -Fqx "$source_line" "$profile"; then
    printf '\n%s\n%s\n' '# Singularity Flow: Copilot model/token/cost telemetry' "$source_line" >> "$profile"
  fi
  # Make telemetry active for the remainder of this installer too.
  . "$env_file"
  printf 'Copilot OpenTelemetry: enabled in %s\n' "$profile"
  printf '%s\n' 'Raw telemetry output: <repository-git-dir>/singularity-flow/copilot-otel.jsonl'
  printf '%s\n' 'Prompt and response content capture remains disabled.'
  printf '%s\n' 'Important: fully exit any currently running Copilot CLI process; telemetry environment cannot be added to an existing process.'
}

cd "$PROJECT_DIR"

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

printf '%s\n' 'Updating the current tracked branch...'
git pull --ff-only

REGISTRY="$(choose_registry)"
printf 'Using npm registry: %s\n' "$REGISTRY"

# Make the selected registry authoritative for every npm process in this installation,
# including npm run lifecycle subprocesses and packaging helpers. Individual install
# commands retain --registry as an auditable defence in depth.
export NPM_CONFIG_REGISTRY="$REGISTRY"

printf '%s\n' 'Installing locked dependencies...'
if [[ "$CLI_ONLY" == "on" ]]; then
  npm ci --workspaces=false --registry="$REGISTRY"
else
  npm ci --registry="$REGISTRY"
fi

printf '%s\n' 'Compiling and validating the project...'
npm run check
if [[ "$CLI_ONLY" == "on" ]]; then
  npm run test:cli
else
  npm run vscode:build
  npm test
fi

printf '%s\n' 'Creating the distribution tarball...'
PACK_OUTPUT="$(npm pack --json)"
TARBALL="$(PACK_OUTPUT="$PACK_OUTPUT" node -e '
  const result = JSON.parse(process.env.PACK_OUTPUT);
  if (!result?.[0]?.filename) throw new Error('"'"'npm pack did not report a tarball filename.'"'"');
  process.stdout.write(result[0].filename);
')"

printf '%s\n' 'Replacing the globally installed CLI...'
npm uninstall --global singularity-flow >/dev/null 2>&1 || true
npm install --global "$PROJECT_DIR/$TARBALL" --registry="$REGISTRY"

if [[ "$CLI_ONLY" != "on" ]]; then
  printf '%s\n' 'Packaging and installing the VS Code extension when the code command is available...'
  npm run vscode:package
  VSIX_PATH="$(find "$PROJECT_DIR/apps/vscode" -maxdepth 1 -type f -name 'singularity-flow-vscode-*.vsix' -print | sort | tail -1)"
  [[ -n "$VSIX_PATH" ]] || { printf '%s\n' 'Error: VS Code packaging did not produce a .vsix.' >&2; exit 1; }
  if command -v code >/dev/null 2>&1; then
    code --install-extension "$VSIX_PATH" --force
  else
    printf 'VS Code CLI not found; install the extension later with: code --install-extension %s --force\n' "$VSIX_PATH"
  fi
fi

printf '%s\n' 'Replacing previous Copilot plugin copies...'
if [[ "$CLI_ONLY" != "on" ]]; then singularity-flow plugin install; fi

printf '%s\n' 'Configuring Copilot model, token, and cost telemetry...'
if [[ "$CLI_ONLY" != "on" ]]; then install_copilot_telemetry; fi

printf '\nInstalled Singularity Flow %s\n' "$(singularity-flow --version)"
printf 'Distribution tarball: %s/%s\n' "$PROJECT_DIR" "$TARBALL"
printf 'Registry: %s\n' "$REGISTRY"
if [[ "$CLI_ONLY" != "on" ]]; then
  copilot plugin list
  printf '%s\n' 'Open a new terminal, then start a new Copilot session to load the refreshed skills and telemetry environment.'
else
  printf '%s\n' 'CLI-only installation complete; VS Code was not built and Copilot plugin/telemetry setup was skipped.'
fi
