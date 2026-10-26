---
name: sflow-initiative-evidence
description: List or register content-addressed initiative checklist evidence with explicit assurance and provenance in GitHub Copilot.
disable-model-invocation: true
argument-hint: "list [CHECK-ID] | add <CHECK-ID> --assurance <LEVEL> [--path FILE | --url URL]"

---
# Manage initiative evidence

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

For listing, run `singularity-flow initiative evidence list [CHECK-ID] --json` and show hash, phase, check, assurance, observation time, freshness, source, and registrar identity.

For registration:

1. Show the active checklist contract with `/sf-initiative-checklist`.
2. Offer only the levels in that check's `acceptedAssurance` and require the contributor's explicit choice and source. `machine-verified` or `system-verified` also needs `--verification` naming the external verifier that produced the result (CI job, tool or system), never your own reading of a file or URL; without one, do not register that level.
3. Preview the phase, checklist item, source, assurance, verification method, applicability decision, reason, and superseded hashes.
4. Run `singularity-flow initiative evidence add <CHECK-ID> --assurance <LEVEL>` with the supplied `--path`, `--url`, `--external-id`, `--observed-state`, `--source-version`, `--verification`, `--decision`, `--reason`, and repeatable `--supersedes` values.
5. Report the content hash, committed evidence copy, commit, and push.

Never infer higher assurance from a URL or file. Every registration is an append-only lifecycle event and must be committed and pushed.
