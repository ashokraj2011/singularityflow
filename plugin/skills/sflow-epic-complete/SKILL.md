---
name: sflow-epic-complete
description: Validate every blocking Story against its approved specification and exact delivery evidence, then record the Product Owner's Epic completion decision.
disable-model-invocation: true
agent: agent

---

# Complete an Epic

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Present artifact references, hashes, identity warnings, and the exact confirmation before recording any decision. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow epic complete <EPIC-KEY> --dry-run --json`.
2. Show every blocking Story, canonical source commit, submitted review packet, exact-SHA check evidence, conformance tree hash, and blocker. Do not hide failed or stale Stories.
3. If any Story is not ready, stop and give its next corrective action. Never weaken the configured checks. Exact-SHA checks currently need a GitHub remote with an authenticated `gh`; on another Git host, relay that as an unsupported-provider limitation, not a retry.
4. Only when it returns `ready` and `authorization.ready`, show the exact Product Owner decision and ask for the exact Epic key; otherwise relay its `authorization.message`.
5. Only after that exact confirmation, run `singularity-flow epic complete <EPIC-KEY> --confirm <EPIC-KEY>`.
6. Link the `spec-to-code-completion.md` report as a verified preview, never its body, with its content-addressed decision hash, commit, and push result.
7. State that configured-local Git identity is not cryptographic authentication and preserve all self-approval warnings.
