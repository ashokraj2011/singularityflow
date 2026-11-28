---
name: sflow-capability-doctor
description: Diagnose workspace capability bindings, approved capability authority, stale proposal history, inherited policy, orphan state branch and ledger chain.
disable-model-invocation: true
agent: agent

---

# Singularity Flow capability doctor

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). A turn that ends with nothing left for SFlow ends with "/sf-next carries it on" (VS Code: Continue).
<!-- sflow-execution-boundary -->
**Boundary:** no Story or repository required; use only the selected lead URL. Resolve local checks with `singularity-flow workspace current --json`; never search `$HOME`. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

This is a deterministic inspection skill. Do not infer capability ownership from
folder or branch names, and do not repair governed state by hand.

1. Run `singularity-flow capability leads --json`. Use the sole result; with several, ask
   which lead URL. With none, say no lead is registered, skip step 2, run step 3's local
   `singularity-flow capabilities doctor --json`, and offer `/sf-capability-map` to register one.
   Never infer a lead from the current folder or chat history.
2. Run `singularity-flow capability fsck --lead <LEAD-URL> --json`. Report every failed
   workspace binding and proposal-history finding with the exact
   remediation supplied by the engine. Do not mutate anything during this check.
3. If repository-local policy diagnostics were requested, run
   `singularity-flow workspace current --json`, change only to its verified
   `repositoryPath`, and run `singularity-flow capabilities doctor --json` there.
4. If the repository maps ambiguously, show the candidates and ask the contributor
   to rerun with `--capability <id>`.
5. Report the exact capability path, effective inherited
   policy, active break-glass leases, and lifecycle pin.
6. Report the configured orphan state branch and its publication mode. A warning
   is not a pass when publication is `required`.
7. Report ledger verification.
8. For a failure, provide the deterministic repair command. Do not create a lease,
   initialize a state branch, or change policy unless asked.

For an unrelated-history proposal, offer the two fsck-reported choices: recreate the
capability from current `sflow/config`, or run the guarded `singularity-flow capability discard-proposal`
command with the full current commit and a contributor-supplied reason. Never use raw
Git deletion, and never discard a valid proposal.

Use `singularity-flow capabilities doctor <ID> --offline --json` when network
access is intentionally unavailable. Offline verification must be labelled as
offline and must not be represented as remote publication proof.
