#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
product_root="$(cd "${script_dir}/.." && pwd)"
repository="${PWD}"
phase=""
task=""
branch=""
views=""
runner=""
workers="2"
publish=false
parallel=false
dry_run=false

usage() {
  cat <<'EOF'
Usage: worldmodel-minimal.sh [options]

Builds the smallest validated Singularity Flow repository world model:
deterministic light depth, zero Copilot/model tokens, one development view,
and a local commit.
Run it while your current directory is the application repository, or pass
--repository explicitly.

Options:
  --repository PATH  Application Git repository (default: current directory).
  --phase ID         Use only the views required by this configured phase.
  --views LIST       Override or add views (comma-separated).
  --task TEXT        Add an exact task guide.
  --branch NAME      Build against an existing branch without switching checkout.
  --parallel         Use semantic quick mode with parallel discovery instead.
  --workers N        Parallel worker limit (default: 2; requires --parallel).
  --runner COMMAND   Override the semantic quick-mode model runner.
  --publish          Follow normal Git publication policy instead of --local.
  --dry-run          Print the exact command without executing it.
  -h, --help         Show this help.

Examples:
  /path/to/singularityflow/scripts/worldmodel-minimal.sh
  /path/to/singularityflow/scripts/worldmodel-minimal.sh --phase design
  /path/to/singularityflow/scripts/worldmodel-minimal.sh --branch WORK-123 --publish
EOF
}

require_value() {
  local option="$1"
  shift
  [[ $# -gt 0 && -n "${1:-}" ]] || {
    echo "Error: ${option} requires a value." >&2
    exit 2
  }
}

while (($#)); do
  case "$1" in
    --repository)
      shift
      require_value --repository "$@"
      repository="$1"
      ;;
    --phase)
      shift
      require_value --phase "$@"
      phase="$1"
      ;;
    --views)
      shift
      require_value --views "$@"
      views="$1"
      ;;
    --task)
      shift
      require_value --task "$@"
      task="$1"
      ;;
    --branch)
      shift
      require_value --branch "$@"
      branch="$1"
      ;;
    --workers)
      shift
      require_value --workers "$@"
      workers="$1"
      [[ "${workers}" =~ ^[1-9][0-9]*$ ]] || {
        echo "Error: --workers must be a positive integer." >&2
        exit 2
      }
      ;;
    --runner)
      shift
      require_value --runner "$@"
      runner="$1"
      ;;
    --parallel) parallel=true ;;
    --publish) publish=true ;;
    --dry-run) dry_run=true ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Error: unknown option '$1'." >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

repository="$(cd "${repository}" 2>/dev/null && pwd)" || {
  echo "Error: repository directory does not exist: ${repository}" >&2
  exit 2
}
git -C "${repository}" rev-parse --show-toplevel >/dev/null 2>&1 || {
  echo "Error: ${repository} is not inside a Git repository." >&2
  exit 2
}
repository="$(git -C "${repository}" rev-parse --show-toplevel)"

if [[ ! -f "${repository}/singularity/workflow.yml" && ! -f "${repository}/singularity/worldmodel.json" ]]; then
  echo "Error: ${repository} is not initialized for Singularity Flow." >&2
  echo "Run 'singularity-flow init' on the intended work branch first." >&2
  exit 2
fi

if [[ -n "${SINGULARITY_FLOW_BIN:-}" ]]; then
  flow=("${SINGULARITY_FLOW_BIN}")
elif command -v singularity-flow >/dev/null 2>&1; then
  flow=("$(command -v singularity-flow)")
else
  flow=("$(command -v node)" "${product_root}/bin/singularity-flow.mjs")
fi

command=("${flow[@]}" wm light)
if [[ -n "${phase}" ]]; then
  command+=(--phase "${phase}")
elif [[ -n "${views}" ]]; then
  command+=(--views "${views}")
else
  command+=(--views development)
fi
[[ -z "${phase}" || -z "${views}" ]] || command+=(--views "${views}")
[[ -z "${task}" ]] || command+=(--task "${task}")
[[ -z "${branch}" ]] || command+=(--branch "${branch}")

if ${parallel}; then
  command=("${flow[@]}" wm build --depth quick --parallel --workers "${workers}")
  if [[ -n "${phase}" ]]; then command+=(--phase "${phase}");
  elif [[ -n "${views}" ]]; then command+=(--views "${views}");
  else command+=(--views development); fi
  [[ -z "${phase}" || -z "${views}" ]] || command+=(--views "${views}")
  [[ -z "${task}" ]] || command+=(--task "${task}")
  [[ -z "${branch}" ]] || command+=(--branch "${branch}")
  [[ -z "${runner}" ]] || command+=(--runner "${runner}")
elif [[ -n "${runner}" ]]; then
  echo "Error: --runner requires --parallel because deterministic light mode does not call a model." >&2
  exit 2
fi
${publish} || command+=(--local)

echo "Repository: ${repository}"
mode="deterministic light (zero model tokens)"
${parallel} && mode="semantic quick with resumable parallel discovery"
echo "Mode: ${mode}"
if ${dry_run}; then
  printf 'Command:'
  printf ' %q' "${command[@]}"
  printf '\n'
  exit 0
fi

cd "${repository}"
exec "${command[@]}"
