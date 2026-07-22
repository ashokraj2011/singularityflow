#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_REGISTRY="https://registry.npmjs.org/"
REGISTRY_OVERRIDE="${SINGULARITY_FLOW_NPM_REGISTRY:-}"
ENABLE_COPILOT_TELEMETRY="${SINGULARITY_FLOW_COPILOT_TELEMETRY:-on}"

usage() {
  printf '%s\n' \
    'Usage: ./install.sh [--registry URL] [--no-copilot-telemetry]' \
    '' \
    'Pull, build, test, package, and globally install Singularity Flow,' \
    'replace all previous Copilot plugin copies, and enable metadata-only' \
    'Copilot OpenTelemetry for model, token, and cost collection.'
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

for command in git node npm copilot; do
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

  local config_dir env_file telemetry_dir telemetry_file shell_name profile source_line temp_file
  config_dir="$HOME/.singularity-flow"
  env_file="$config_dir/copilot-otel.sh"
  telemetry_dir="$HOME/.copilot"
  telemetry_file="$telemetry_dir/singularity-flow-otel.jsonl"
  source_line='[ -r "$HOME/.singularity-flow/copilot-otel.sh" ] && . "$HOME/.singularity-flow/copilot-otel.sh"'

  mkdir -p "$config_dir" "$telemetry_dir"
  chmod 700 "$config_dir" "$telemetry_dir"
  temp_file="$(mktemp "$config_dir/copilot-otel.sh.XXXXXX")"
  printf '%s\n' \
    '# Managed by the Singularity Flow installer.' \
    '# Records model, token, timing, and cost metadata. Prompt/response content remains disabled.' \
    'if [ -z "${COPILOT_OTEL_FILE_EXPORTER_PATH:-}" ] && [ -z "${OTEL_EXPORTER_OTLP_ENDPOINT:-}" ] && [ -z "${COPILOT_OTEL_ENABLED:-}" ]; then' \
    '  export COPILOT_OTEL_FILE_EXPORTER_PATH="$HOME/.copilot/singularity-flow-otel.jsonl"' \
    'fi' > "$temp_file"
  chmod 600 "$temp_file"
  mv "$temp_file" "$env_file"
  touch "$telemetry_file"
  chmod 600 "$telemetry_file"

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
      printf 'Telemetry output: %s\n' "$telemetry_file"
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
  printf 'Telemetry output: %s\n' "$telemetry_file"
  printf '%s\n' 'Prompt and response content capture remains disabled.'
}

cd "$PROJECT_DIR"

if [[ -n "$(git status --porcelain)" ]]; then
  printf '%s\n' 'Error: the checkout has uncommitted changes. Commit or stash them before installation.' >&2
  git status --short >&2
  exit 1
fi

printf '%s\n' 'Updating the current tracked branch...'
git pull --ff-only

REGISTRY="$(choose_registry)"
printf 'Using npm registry: %s\n' "$REGISTRY"

printf '%s\n' 'Installing locked dependencies...'
npm ci --registry="$REGISTRY"

printf '%s\n' 'Compiling and validating the project...'
npm run desktop:build
npm test
npm run check

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

printf '%s\n' 'Replacing previous Copilot plugin copies...'
singularity-flow plugin install

printf '%s\n' 'Configuring Copilot model, token, and cost telemetry...'
install_copilot_telemetry

printf '\nInstalled Singularity Flow %s\n' "$(singularity-flow --version)"
printf 'Distribution tarball: %s/%s\n' "$PROJECT_DIR" "$TARBALL"
printf 'Registry: %s\n' "$REGISTRY"
copilot plugin list
printf '%s\n' 'Open a new terminal, then start a new Copilot session to load the refreshed skills and telemetry environment.'
