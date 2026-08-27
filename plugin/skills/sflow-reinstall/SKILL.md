---
name: sflow-reinstall
description: Preview and deliberately replace only the locally installed Singularity Flow CLI, VS Code extension, Copilot plugin, managed direct skills, and managed telemetry wrapper.
disable-model-invocation: true
argument-hint: "--checkout <path> [--registry <url>]"

---
# Clean-reinstall the local Singularity Flow product

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.
installation surfaces, and perform the exact confirmed transaction. Preserve its complete preview,
verification result, recovery command, and receipt path.

This operation replaces product tooling only. It never modifies, deletes, scans, fetches, checks out,
commits, or pushes a Git repository. It preserves every repository `singularity/`, `.singularity/`,
and `.git/singularity-flow/` directory; all workspace directories and registrations; VS Code state;
credentials; Node.js; npm; and personal Copilot skills that lack the managed marker.

1. Require the contributor to identify the Singularity Flow source checkout to install.
2. Run the preview:

   ```bash
   sf-reinstall --checkout "<CHECKOUT>" --dry-run
   ```

   Add `--registry "<URL>"` when a corporate npm registry or Artifactory is required. Add
   `--cli-only` only when the contributor explicitly wants to omit Copilot and VS Code surfaces.
3. Show the complete **Replace**, **Preserve**, artifact hashes, fingerprint, and any unavailable
   optional surface. Do not summarize away a preserved-data guarantee.
4. The contributor must provide the exact fingerprint-bound confirmation in a separate response.
   Never generate, infer, or submit it on their behalf.
5. After that explicit response, run the same command with:

   ```bash
   sf-reinstall --checkout "<CHECKOUT>" --confirm "<EXACT CONFIRMATION>"
   ```

   Repeat the same `--registry`, `--cli-only`, and telemetry choices used for the preview.
6. Report the verified CLI, VS Code extension, Copilot plugin, direct-skill inventory, and the
   machine-local receipt under `~/.singularity-flow/installations/`.

Never substitute `factory-reset`, `local-reset`, `fresh-install`, `git clean`, or a home-directory
search. If application fails after removal, preserve and show the CLI's recovery command exactly.
