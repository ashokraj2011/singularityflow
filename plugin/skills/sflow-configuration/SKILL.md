---
name: sflow-configuration
description: Inspect, validate, publish, or explicitly recreate and sync governed configuration without Git merge questions.
disable-model-invocation: true
argument-hint: "show|explain [--pointer <JSON-POINTER>]|validate|save <path>|publish|recreate-sync [--apply]"
---
# Manage governed configuration

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. For `show` or `explain`, run the exact requested read-only command and preserve any explicit
   `--pointer`; do not substitute validation or a write.
2. For `recreate-sync`, run the read-only preview unless the user explicitly requests recreation and sync. That request authorizes `singularity-flow configuration recreate-sync --apply --json` without follow-up merge or confirmation questions. The main-panel **Recreate & sync configuration** menu performs the same model-free operation. Preserve its backups and effects; never reset application code or Story history, and never apply merely because a proposal conflict was reported. The operation owns validation; do not add a pre-validation or another publication command.
3. For other writes, run `singularity-flow configuration validate --json` before proposing any write.
4. For save, require the exact reviewed source path. For publish, show the changed governed files, target configuration branch, commit message, and remote state.
5. Require an explicit mutation request, then run only the selected `singularity-flow configuration save` or `singularity-flow configuration publish` operation.
6. Report validation, commit, push, and active-work invalidation effects. Never edit lifecycle snapshots or publish directly to an application branch.

Always report the equivalent routes:

- Shell: the exact `singularity-flow configuration ...` command that was run or offered.
- Copilot: `/sf-configuration` with the same explicit operation and operands.
