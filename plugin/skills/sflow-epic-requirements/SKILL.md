---
name: sflow-epic-requirements
description: Formalize pinned Epic sources into requirements, traceability, and repository impact analysis, then publish one governed Requirements bundle.
disable-model-invocation: true

---

# Build the Epic Requirements bundle

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Author configured artifacts from governed inputs and pinned clarification; publish only after readiness. Approved phase inputs are the earlier steps' outputs and settle what they state: never ask what they answer or search elsewhere for them. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. When a result's `act.state` is `author`, or it routes back to this skill with nothing for a person to answer, edit, review or confirm, that is this turn's own work: do it, never relay it. A file edit that does not match is not a refusal: read the file again and redo the edit.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow epic requirements status --json`. Epic Intake accepts the Jira identity and pinned sources automatically; do not build or request a repository world model on `main` or the Epic branch.
2. List pinned inputs with `singularity-flow epic sources list --epic <EPIC-KEY>`.
3. Record every business note with `singularity-flow epic sources note --text-file <FILE>` and every accepted Copilot answer with `singularity-flow epic sources answer --text-file <FILE>`, writing FILE only at the source-text draft this turn's rules name, one at a time. Never leave accepted answers only in chat history.
4. Run `singularity-flow epic requirements prepare`. Read the complete governed context that it prints: phase contract, governed agent, Jira snapshot, pinned sources, question ledger, and workspace repository registry. Repository grounding is added later, after each Story has its canonical branch.
5. Use `ask_user` to ask one concise batch of material questions and wait. Even when the pinned evidence looks complete, ask the contributor to confirm your concise interpretation of outcome, boundaries, and acceptance criteria. If `ask_user` is unavailable, display the questions and stop before authoring or publication. Record every accepted answer with `singularity-flow epic sources answer`, rebuild context, and continue. Unanswered questions stay visible; never fabricate scope.
6. Author every output at the exact path `singularity-flow epic requirements prepare` lists (by default `requirements.md`, `traceability.yml` and `impact-analysis.yml`). Use stable `REQ-nnn` and `AC-nnn` identifiers and cite exact `SRC-nnn` evidence.
7. Run `singularity-flow initiative phase draft-check epic-requirements --initiative <EPIC-KEY> --json`. If unready, act only on its `findings` and `correction`, rerun its `commands.recheck` at most twice, and stop on an unchanged fingerprint. Only when `status` is `ready`, run `singularity-flow epic requirements publish`, summarize every output with verified preview/file links and hashes, and stop for human review of the complete bound documents outside chat. Do not reproduce bodies or infer review from links.
8. After explicit approval, hand off to `/sf-initiative-approve <EPIC-KEY> phase` for its receipt and self-approval flow. Never approve automatically.
