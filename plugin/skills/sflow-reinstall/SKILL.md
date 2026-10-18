---
name: sflow-reinstall
description: Preview and deliberately replace only the locally installed Singularity Flow CLI, VS Code extension, Copilot plugin, managed direct skills, and managed telemetry wrapper.
disable-model-invocation: true
argument-hint: "--checkout <path> [--registry <url>]"

---
# Clean-reinstall the local Singularity Flow product

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.
Preserve the complete preview, verification, recovery command, and receipt path.

This operation replaces product tooling only. It never modifies, deletes, scans, fetches, checks out,
commits, or pushes a Git repository. It preserves every repository `singularity/`, `.singularity/`,
and `.git/singularity-flow/` directory; all workspace directories and registrations; VS Code state;
credentials; Node.js; npm; and personal Copilot skills that lack the managed marker.

1. Require the contributor to identify the Singularity Flow source checkout to install.
2. Run the preview:

   ```bash
   sf-reinstall --checkout "<CHECKOUT>" --dry-run
   ```

   Use `--registry "<URL>"` for a company registry; `--cli-only` only to omit Copilot/VS Code by request.
   `--skip-tests` requires explicit consent, never inferred from failures. Keep build/artifact checks;
   disclose skipped tests.
3. Show the complete **Replace**, **Preserve**, artifact hashes, fingerprint, and any unavailable
   optional surface. Do not summarize away a preserved-data guarantee.
4. The contributor must provide the exact fingerprint-bound confirmation in a separate response.
   Never generate, infer, or submit it on their behalf.
5. After that explicit response, run the same command with:

   ```bash
   sf-reinstall --checkout "<CHECKOUT>" --confirm "<EXACT CONFIRMATION>"
   ```

   Repeat the same `--registry`, `--cli-only`, `--skip-tests`, and telemetry choices used for the preview.
6. Build/test/package output is staging, not activation; matching versions do not prove build identity.
   Report full installation only when the final
   banner is exactly `Singularity Flow product activation — COMPLETE AND VERIFIED`, the installed
   `singularity-flow --build` identity matches the admitted candidate, all selected surfaces verify
   (including `singularity-flow plugin verify --json` when Copilot is selected), and
   `~/.singularity-flow/installations/current.json` is committed. Report an explicitly narrowed
   install as `Singularity Flow product activation — PARTIAL BY REQUEST`. An unavailable optional
   manager reports `Singularity Flow product activation — COMPLETE WITH SKIPS` and the skipped surface.
   Preserve the `(TESTS SKIPPED)` banner suffix; never claim those tests passed.
7. Report the verified CLI build, VS Code extension, Copilot plugin, direct-skill inventory, and the
   committed machine-local installation receipt.

Never substitute reset commands, `git clean`, or home-directory search. Without a recognized final
banner, show the exact recovery command and never infer success. A legacy install lacking retained
prior bytes recovers forward from the verified candidate; do not claim rollback.
