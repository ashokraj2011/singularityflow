---
name: sflow-sgos
description: Run an exact Singularity Governed Operating System command without changing its CLI family or bypassing its authority and confirmation boundaries.
disable-model-invocation: true
agent: agent
argument-hint: "<intent|program|process|policy|task|request|evidence|candidate|execution-unit|device|authority-store|pack|memory|meta-tool> <SUBCOMMAND> [arguments]"
---
# Governed SGOS command relay

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Relay one explicitly requested SGOS command to the same CLI family.

1. Require one listed family and an explicit subcommand. Never infer either value.
2. Run `singularity-flow $ARGUMENTS` from the resolved repository and preserve the complete result.
   Never prepend `workflow` or translate it into `singularity-flow workflow ...`.
3. Preserve every CLI model, trust, identity, revision, exact-hash, confirmation, and authority
   check. Never invent a file, ID, choice, approval, credential, digest, or human response.
4. Show a returned preview, plan, or next command with its effects and stop.
   Confirm only after the contributor explicitly accepts the exact result in a later turn.
5. Never run a returned next command automatically. Execute only the explicitly requested operation
   after all CLI guards pass.
6. Use `/sf-sgos-create` for `singularity-flow intent workflow-guide` and
   `singularity-flow intent workflow-create`; `/sf-learn` for learning; and `/sf-workflows` only for
   the separate `singularity-flow workflow ...` catalog.

Report the exact `singularity-flow $ARGUMENTS` action on all three surfaces per the Output contract; preserve its operands.
