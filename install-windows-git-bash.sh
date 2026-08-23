#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REGISTRY="${SINGULARITY_FLOW_NPM_REGISTRY:-${NPM_CONFIG_REGISTRY:-}}"
CLI_ONLY="off"
SKIP_TESTS="off"
TELEMETRY="on"
WORKSPACE_CONFIGURATION_REFRESH="on"

usage() {
  cat <<'EOF'
Usage: bash ./install-windows-git-bash.sh [options]

Update, validate, and install Singularity Flow from Git Bash on Windows.

Options:
  --registry URL          Use a company npm registry or Artifactory.
  --cli-only              Install only the CLI; skip VS Code and Copilot.
  --skip-tests            Keep checks/builds, but skip the long test suite.
  --no-copilot-telemetry  Do not install the local telemetry shell wrapper.
  --no-workspace-configuration-refresh
                          Do not refresh registered repository configuration/state branches.
  -h, --help              Show this help.

Registry credentials belong in the user's .npmrc, never in the URL.
This wrapper does not change Git line-ending settings or rewrite repository files.
EOF
}

fail() {
  printf 'Windows installer error: %s\n' "$1" >&2
  exit 1
}

while (($#)); do
  case "$1" in
    --registry)
      [[ $# -ge 2 ]] || fail '--registry requires a URL.'
      REGISTRY="$2"
      shift 2
      ;;
    --registry=*)
      REGISTRY="${1#--registry=}"
      shift
      ;;
    --cli-only)
      CLI_ONLY="on"
      shift
      ;;
    --skip-tests)
      SKIP_TESTS="on"
      shift
      ;;
    --no-copilot-telemetry)
      TELEMETRY="off"
      shift
      ;;
    --no-workspace-workflow-sync|--no-workspace-configuration-refresh)
      WORKSPACE_CONFIGURATION_REFRESH="off"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown option: $1"
      ;;
  esac
done

case "$(uname -s 2>/dev/null || true)" in
  MINGW*|MSYS*|CYGWIN*) ;;
  *)
    printf '%s\n' 'Warning: this wrapper is intended for Git Bash on Windows.' >&2
    ;;
esac

for command in bash git node npm; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || fail 'could not determine the Node.js version.'
(( NODE_MAJOR >= 20 )) || fail "Node.js 20 or newer is required; found $(node --version)."

if [[ "$CLI_ONLY" != "on" ]]; then
  command -v copilot >/dev/null 2>&1 || fail 'Copilot CLI was not found. Install it first, or use --cli-only.'
fi

[[ -f "$PROJECT_DIR/package.json" ]] || fail "package.json was not found beside this script: $PROJECT_DIR"
[[ -f "$PROJECT_DIR/install.sh" ]] || fail "install.sh was not found beside this script: $PROJECT_DIR"
git -C "$PROJECT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1 || fail "not a Git checkout: $PROJECT_DIR"

if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
  printf '%s\n' 'The Singularity Flow checkout has uncommitted changes:' >&2
  git -C "$PROJECT_DIR" status --short >&2
  fail 'commit or stash those changes, then run this script again.'
fi

printf '%s\n' 'Updating Singularity Flow with a fast-forward-only pull...'
git -C "$PROJECT_DIR" pull --ff-only

# The Windows installer failure fixed in August 2026 was caused by treating CRLF
# Agent Markdown as if its frontmatter were absent. Check for the regression before
# the normal installer enters its longer build and test stages.
if ! grep -Fq 'Git for Windows commonly checks Markdown out with CRLF' "$PROJECT_DIR/src/agents.mjs"; then
  fail 'this checkout predates the Windows CRLF fix. Switch to an updated tracked branch and retry.'
fi

INSTALL_ARGS=()
[[ -n "$REGISTRY" ]] && INSTALL_ARGS+=(--registry "$REGISTRY")
[[ "$CLI_ONLY" == "on" ]] && INSTALL_ARGS+=(--cli-only)
[[ "$SKIP_TESTS" == "on" ]] && INSTALL_ARGS+=(--skip-tests)
[[ "$TELEMETRY" == "off" ]] && INSTALL_ARGS+=(--no-copilot-telemetry)
[[ "$WORKSPACE_CONFIGURATION_REFRESH" == "off" ]] && INSTALL_ARGS+=(--no-workspace-configuration-refresh)

printf '%s\n' 'Windows CRLF compatibility: ready.'
printf '%s\n' 'Starting the validated Singularity Flow installer...'
exec bash "$PROJECT_DIR/install.sh" "${INSTALL_ARGS[@]}"
