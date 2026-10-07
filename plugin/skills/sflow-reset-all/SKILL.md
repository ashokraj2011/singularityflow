---
name: sflow-reset-all
description: Preview and explicitly reset the current repository plus machine registration while preserving physical workspaces and clones.
disable-model-invocation: true

---
# Reset repository and machine registration

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow reset-all --json` without `--yes` and show the complete remove and preserve lists.
2. Explain that governed repository configuration and machine registration are reset, while physical workspace directories, clones, application source, Git history, installed product surfaces, and VS Code keychain credentials are preserved.
3. Stop for explicit confirmation. Never infer consent from the original request or add `--yes` during preview.
4. Only after a separate confirmation, run `singularity-flow reset-all --yes --json`.
5. Report every changed path and the exact next initialization step. Never substitute factory reset, local reset, fresh install, or reinstall.

