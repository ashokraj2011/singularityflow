---
name: sflow-initiative-evidence
description: List or register content-addressed initiative checklist evidence with explicit assurance and provenance in GitHub Copilot.
disable-model-invocation: true
agent: agent
argument-hint: "list [CHECK-ID] | add <CHECK-ID> --assurance <LEVEL> [--path FILE | --url URL]"

---
# Manage initiative evidence

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). A turn that ends with nothing left for SFlow ends with "/sf-next carries it on" (or press Continue).
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

For listing, run `singularity-flow initiative evidence list [CHECK-ID] --json` and show phase, check, assurance, observation time, freshness, source, and registrar identity.

For registration:

1. Show the active checklist contract with `/sf-initiative-checklist`.
2. Offer only the levels in that check's `acceptedAssurance` and require the contributor's explicit choice and source. `machine-verified` or `system-verified` also needs `--verification` naming the external verifier that produced the result (CI job, tool or system), never your own reading of a file or URL; without one, do not register that level.
3. Preview the phase, checklist item, source, assurance, verification method, applicability decision, reason, and the evidence it supersedes.
4. Run `singularity-flow initiative evidence add <CHECK-ID> --assurance <LEVEL>` with the supplied `--path`, `--url`, `--external-id`, `--observed-state`, `--source-version`, `--verification`, `--decision`, `--reason`, and repeatable `--supersedes` values.
5. Report the committed evidence copy, commit, and push.

Never infer higher assurance from a URL or file. Every registration is an append-only lifecycle event and must be committed and pushed.
