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
SKIP_VSCODE="off"
SKIP_TESTS="off"
FACTORY_RESET="off"
FACTORY_RESET_CONFIRMED="off"
CLEAN_REINSTALL="off"
REINSTALL_DRY_RUN="off"
REINSTALL_CONFIRM=""
REFRESH_REGISTERED_WORKSPACE_CONFIGURATION="on"
REFRESH_VSCE_TOOLCHAIN="off"
VSIX_PATH=""

# Every long-running step prints its own elapsed seconds. The last slow-install investigation had
# to be reconstructed from npm's debug logs; the transcript itself should answer "which step".
STEP_LABEL=""
STEP_STARTED=0
step_begin() { STEP_LABEL="$1"; STEP_STARTED=$SECONDS; printf '%s\n' "$1..."; }
step_end() { printf '%s\n' "  ${STEP_LABEL}: $((SECONDS - STEP_STARTED))s"; }

usage() {
  printf '%s\n' \
    'Usage: ./install.sh [--registry URL] [--no-copilot-telemetry] [--cli-only | --skip-vscode] [--skip-tests] [--refresh-vsce-toolchain] [--no-workspace-configuration-refresh]' \
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
    '--skip-vscode installs the CLI, Copilot plugin, skills, and telemetry without replacing the VS Code extension' \
    '--refresh-vsce-toolchain reinstalls the cached VSCE packaging toolchain instead of reusing it' \
    'or test:cli. Use it only when this exact commit has already passed its tests.'
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
    --skip-vscode)
      SKIP_VSCODE="on"
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
if [[ "$SKIP_VSCODE" == "on" && ( "$FACTORY_RESET" == "on" || "$CLEAN_REINSTALL" == "on" ) ]]; then
  printf '%s\n' 'Error: --skip-vscode is supported only by a normal install; reset and clean-reinstall replace their complete declared surface.' >&2
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
    "# Never shadows the user's copilot executable. SFlow provisions only processes it launches." \
    'sflow_copilot() {' \
    '  command singularity-flow copilot "$@"' \
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
      printf '%s\n' 'Use sflow copilot for consented, story-scoped local usage capture.'
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
    printf '%s\n' 'WARNING: CLI tests skipped by request; this exact commit must already have passed them.' >&2
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
    printf '%s\n' 'WARNING: full test suite skipped by request; this exact commit must already have passed it.' >&2
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
if [[ -f "$PROJECT_DIR/scripts/stamp-build-info.mjs" ]]; then
  printf '%s\n' 'Stamping build provenance...'
  BUILD_INFO_BACKUP="$(mktemp "${TMPDIR:-/tmp}/sflow-build-info.XXXXXX")"
  cp "$PROJECT_DIR/src/build-info.mjs" "$BUILD_INFO_BACKUP"
  trap restore_build_info EXIT
  node "$PROJECT_DIR/scripts/stamp-build-info.mjs"
elif [[ -f "$PROJECT_DIR/src/build-info.mjs" ]]; then
  printf '%s\n' 'Error: build provenance stamper is missing; refusing to package an unidentified build.' >&2
  exit 1
fi

printf '%s\n' 'Creating the distribution tarball...'
PACK_OUTPUT="$(npm pack --json)"
restore_build_info
trap - EXIT
TARBALL="$(PACK_OUTPUT="$PACK_OUTPUT" node -e '
  const result = JSON.parse(process.env.PACK_OUTPUT);
  if (!result?.[0]?.filename) throw new Error('"'"'npm pack did not report a tarball filename.'"'"');
  process.stdout.write(result[0].filename);
')"

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

if [[ "$CLI_ONLY" != "on" && "$SKIP_VSCODE" != "on" ]]; then
  if command -v code >/dev/null 2>&1; then
    step_begin 'Installing the VS Code extension'
    if ! code --install-extension "$VSIX_PATH" --force; then
      printf '%s\n' 'Error: VS Code did not accept the newly packaged extension; the existing CLI and Copilot plugin were not changed.' >&2
      printf 'Retry exactly: code --install-extension %q --force\n' "$VSIX_PATH" >&2
      exit 1
    fi
    step_end
  else
    printf 'VS Code CLI not found; install the extension later with: code --install-extension %s --force\n' "$VSIX_PATH"
  fi
fi

printf '%s\n' 'Replacing the globally installed CLI...'
step_begin 'Installing the CLI globally'
npm uninstall --global singularity-flow >/dev/null 2>&1 || true
npm install --global "$PROJECT_DIR/$TARBALL" --registry="$REGISTRY"
step_end

if [[ "$CLI_ONLY" != "on" ]]; then
  step_begin 'Replacing previous Copilot plugin copies'
  singularity-flow plugin install
  step_end
fi

if [[ "$CLI_ONLY" != "on" ]]; then
  step_begin 'Configuring Copilot model, token, and cost telemetry'
  install_copilot_telemetry
  step_end
fi

step_begin 'Refreshing approved configuration in every registered workspace repository'
WORKSPACE_REFRESH_STATUS="complete"
if ! refresh_registered_workspace_configurations; then
  WORKSPACE_REFRESH_STATUS="pending"
  printf '%s\n' 'WARNING: product surfaces are installed, but workspace configuration refresh is pending.' >&2
  printf '%s\n' 'Retry exactly: singularity-flow workspace refresh-configuration' >&2
fi
step_end

# The manifest is written only after every requested product surface has completed. Workspace
# maintenance has its own explicit pending state and retry command, so a slow or unavailable clone
# cannot make an otherwise coherent installation look rolled back.
INSTALL_MANIFEST_DIR="$HOME/.singularity-flow/installations"
mkdir -p "$INSTALL_MANIFEST_DIR"
INSTALL_MANIFEST_TEMP="$(mktemp "$INSTALL_MANIFEST_DIR/current.json.XXXXXX")"
node -e '
  const fs = require("node:fs");
  const [file, version, checkout, tarball, vsix, workspaceRefresh] = process.argv.slice(1);
  fs.writeFileSync(file, JSON.stringify({
    schemaVersion: 1, status: workspaceRefresh === "complete" ? "complete" : "workspace-refresh-pending",
    version, checkout, tarball, vsix: vsix || null, workspaceRefresh, installedAt: new Date().toISOString()
  }, null, 2) + "\n", {mode: 0o600});
' "$INSTALL_MANIFEST_TEMP" "$(singularity-flow --version)" "$PROJECT_DIR" "$PROJECT_DIR/$TARBALL" "$VSIX_PATH" "$WORKSPACE_REFRESH_STATUS"
mv "$INSTALL_MANIFEST_TEMP" "$INSTALL_MANIFEST_DIR/current.json"

printf '\nInstalled Singularity Flow %s\n' "$(singularity-flow --version)"
# Named explicitly, because the CLI on PATH is a *copy* and not a link to this checkout: editing
# these sources changes nothing about the installed command until install.sh runs again.
printf 'Built from checkout: %s\n' "$PROJECT_DIR"
printf 'Distribution tarball: %s/%s\n' "$PROJECT_DIR" "$TARBALL"
printf 'Registry: %s\n' "$REGISTRY"
if [[ "$CLI_ONLY" != "on" ]]; then
  copilot plugin list
  printf '%s\n' 'Open a new terminal, then start a new Copilot session to load the refreshed skills and telemetry environment.'
else
  printf '%s\n' 'CLI-only installation complete; VS Code was not built and Copilot plugin/telemetry setup was skipped.'
fi
