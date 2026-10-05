---
name: sflow-fresh-install
description: Preview and explicitly perform a true fresh Singularity Flow installation from a validated source checkout.
disable-model-invocation: true
argument-hint: "--checkout <path>"
---
# Perform a true fresh installation

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.

This is the broadest local reset: it removes validated managed workspace roots and clones, clears managed local and Copilot state, replaces installed product surfaces, and preserves unregistered repositories and personal skills.

1. Require the Singularity Flow source checkout and run `singularity-flow fresh-install --checkout "<CHECKOUT>"` without `--yes`.
2. Show every remove, preserve, and install target. Do not summarize away physical workspace deletion.
3. Stop for a separate explicit confirmation.
4. Only then repeat the command with `--yes`, preserving any requested corporate `--registry`, `--cli-only`, or telemetry option.
5. Report verification and recovery output exactly. Never substitute `/sf-reinstall`, which intentionally preserves workspaces.

