#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLIC_REGISTRY="https://registry.npmjs.org/"
REGISTRY_OVERRIDE="${SINGULARITY_FLOW_NPM_REGISTRY:-}"

usage() {
  printf '%s\n' \
    'Usage: ./install.sh [--registry URL]' \
    '' \
    'Pull, build, test, package, and globally install Singularity Flow,' \
    'then replace all previous Copilot plugin copies with the current one.'
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

printf '\nInstalled Singularity Flow %s\n' "$(singularity-flow --version)"
printf 'Distribution tarball: %s/%s\n' "$PROJECT_DIR" "$TARBALL"
printf 'Registry: %s\n' "$REGISTRY"
copilot plugin list
printf '%s\n' 'Start a new Copilot session to load the refreshed skills.'
