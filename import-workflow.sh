#!/usr/bin/env bash
# Import one workflow bundle and make it live, in one step.
#
#   ./import-workflow.sh path/to/workflow.json
#
# Run it from the repository that should get the workflow, or from anywhere once a workspace is
# selected with `singularity-flow workspace use <WORKSPACE>`. It previews the bundle, imports it as
# a configuration proposal and activates that proposal straight away, with no separate review.
#
# Where a name in the bundle (an agent, a template, a step, the workflow itself) already exists here
# with different content, yours is kept and used, and the script lists what it kept. Running it
# twice changes nothing. To import theirs under new names ending in "-imported" instead, run
#   SFLOW_IMPORT_CONFLICTS=suggested ./import-workflow.sh path/to/workflow.json
# and to overwrite yours with theirs, SFLOW_IMPORT_CONFLICTS=replace.
set -u

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 <workflow-bundle.json>" >&2
  exit 2
fi
if [ ! -f "$1" ]; then
  echo "No such file: $1" >&2
  exit 2
fi
bundle="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
conflicts="${SFLOW_IMPORT_CONFLICTS:-keep}"

# The installed CLI, else the one beside this script in a Singularity Flow checkout.
if command -v singularity-flow >/dev/null 2>&1; then cli=(singularity-flow)
elif command -v sflow >/dev/null 2>&1; then cli=(sflow)
elif [ -f "$(dirname "$0")/bin/singularity-flow.mjs" ]; then cli=(node "$(cd "$(dirname "$0")" && pwd)/bin/singularity-flow.mjs")
else
  echo "singularity-flow is not on PATH. Install Singularity Flow first." >&2
  exit 1
fi

errors="$(mktemp "${TMPDIR:-/tmp}/sflow-import.XXXXXX")"
trap 'rm -f "$errors"' EXIT

# Run the CLI with --json: its answer goes to $out, anything it says on stderr to $errors.
flow() { out="$("${cli[@]}" "$@" --json 2>"$errors")"; }
# Print one field (a.b.c) of the JSON answer in $out; a list prints its ids. Nothing when absent.
field() {
  printf '%s' "$out" | node -e '
    let text = ""; process.stdin.on("data", (chunk) => { text += chunk; }).on("end", () => {
      let value; try { value = JSON.parse(text); } catch { return; }
      for (const key of process.argv[1].split(".")) value = value?.[key];
      if (Array.isArray(value)) value = value.map((item) => item?.id ?? item).join(", ");
      if (value !== undefined && value !== null) process.stdout.write(String(value));
    });' "$1"
}
# Stop with the command's own explanation.
fail() {
  message="$(field error.message)"
  message="${message:-$(cat "$errors")}"
  echo "$1: $message" >&2
  case "$message" in
    *"singularity/workflow.yml does not exist"*|*"not set up for Singularity Flow"*)
      echo "It ran in $(pwd), which is not a Singularity Flow repository." >&2
      echo "cd into your project's repository and run it again, or select it once with: ${cli[*]} workspace use <WORKSPACE>" >&2 ;;
  esac
  exit 1
}

echo "Previewing $(basename "$bundle")..."
flow workflow import "$bundle" --dry-run --propose --resolve-all "$conflicts" || fail "Preview failed"
if [ "$(field status)" != "ready" ]; then
  # Show what blocks it, in the CLI's own words.
  "${cli[@]}" workflow import "$bundle" --dry-run --propose --resolve-all "$conflicts"
  echo "The bundle cannot be imported as it is; see above." >&2
  exit 1
fi
kept="$(field kept)"
[ -n "$kept" ] && echo "Already here with different content, so yours is kept: $kept"
if [ "$(field counts.add)" = "0" ] && [ "$(field counts.replace)" = "0" ]; then
  echo "Nothing to import: everything else in this bundle is already here."
  exit 0
fi
plan="$(field planSha256)"

# A repository with an approved configuration branch (sflow/config) takes the import as a proposal,
# activated below. Without one, the import is written into this checkout's configuration files.
if [ "$(field destinationAuthority.kind)" != "approved-configuration-ref" ]; then
  echo "Importing into this checkout..."
  flow workflow import "$bundle" --resolve-all "$conflicts" --confirm "$plan" || fail "Import failed"
  echo "Done: $(field workflows) is imported into this checkout's files (not committed): $(field paths)"
  exit 0
fi

echo "Importing..."
flow workflow import "$bundle" --resolve-all "$conflicts" --confirm "$plan" --propose || fail "Import failed"
workflows="$(field workflows)"
branch="$(field branch)"
commit="$(field commit)"
if [ "$(field pushed)" = "false" ]; then
  echo "The import was saved on this computer but not uploaded, so it cannot be activated yet." >&2
  echo "Check that you can push to the remote repository, then run: ${cli[*]} push retry $(field transportIntent)" >&2
  exit 1
fi

echo "Activating..."
if ! flow workflow activate "$branch" --confirm "$commit" --acknowledge-unprotected; then
  message="$(field error.message)"
  echo "Activation failed: ${message:-$(cat "$errors")}" >&2
  echo "The import is waiting for review as $branch." >&2
  exit 1
fi
# Pick up the new configuration; the workflow is already active if this has nothing to do.
"${cli[@]}" workspace refresh-configuration >/dev/null 2>&1 || true

echo "Done: $workflows is active and can start new Stories."
