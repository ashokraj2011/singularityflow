---
name: sflow-fresh-install
description: Preview and explicitly perform a true fresh Singularity Flow installation from a validated source checkout.
disable-model-invocation: true
argument-hint: "--checkout <path>"
---
# Perform a true fresh installation

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal or any stop, relay the returned route before ending: `remediationPlan` steps, else `commandGuidance`, `nextAction`, `continuation.actions` or `recovery.actions`, in that order; with none, offer `/sf-nextsteps`. Never retry an unchanged condition; run a returned action only when the person asks.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

This is the broadest local reset: it removes validated managed workspace roots and clones, clears managed local and Copilot state, replaces installed product surfaces, and preserves unregistered repositories and personal skills.

1. Require the Singularity Flow source checkout and run `singularity-flow fresh-install --checkout "<CHECKOUT>"` without `--yes`. Fresh install works only from a source checkout. With only a promoted release directory, say so and stop; the person may instead choose `/sf-local-reset` for machine state and then the release install `sf-install --release-dir "<DIR>" --artifact-key "<PUBLIC-KEY>" --dry-run`, previewed and confirmed as in `/sf-reinstall`.
2. Show every remove, preserve, and install target. Do not summarize away physical workspace deletion.
3. Stop for a separate explicit confirmation.
4. Only then repeat the command with `--yes`, preserving any requested corporate `--registry`, `--cli-only`, or telemetry option.
5. Report verification and recovery output exactly. Never substitute `/sf-reinstall`, which intentionally preserves workspaces.

