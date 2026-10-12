---
name: sflow-initiative-approve
description: Review exact initiative output or phase-bundle hashes and record an authorized approval from GitHub Copilot.
disable-model-invocation: true
argument-hint: "<OUTPUT-ID|phase> [--initiative INIT-ID]"

---
# Approve an initiative output or phase

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Present artifact references, hashes, identity warnings, and the exact confirmation before recording any decision. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Approval authority comes from configured local Git name/email groups, not the selected agent. Report identity assurance as `configured-local`, never cryptographic authentication.

1. Use `/sf-initiative-documents` and `/sf-initiative-checklist` for exact output links/hashes, evidence assurance/freshness, prior approvals, child milestones and self-approval risk. Require the human's complete review of these bound outputs outside chat; opening a preview or a summary is not review. Changed bindings need fresh review before confirmation.
2. Run `singularity-flow initiative choices begin approve <INIT-ID> <OUTPUT-ID|phase> --json`.
3. Present exactly the returned `choiceSets` with Copilot's `ask_user` (the `phase:subject` confirmation); the phase agent is the default and grants no approval authority.
4. The reviewer must choose the confirmation explicitly. Never infer, preselect, or synthesize approval intent.
5. Record each answer with `singularity-flow initiative choices answer <TOKEN> <CHOICE-ID> <SELECTED-ID> --json`.
6. Only after `ready: true`, run `singularity-flow initiative approve <OUTPUT-ID|phase> --initiative <INIT-ID> --selection-receipt <TOKEN>`. A self-approval refusal: show it; only if the reviewer explicitly accepts self-approval, rerun with `--acknowledge-self-approval`.
7. Report the approved content/bundle hash, actor identity, authority group, governed agent, self-approval warning, remaining distinct approvals, advancement, commit, and push.
8. When phase approval advances the initiative, reproduce the CLI's context-boundary guidance. For `new`, stop and ask the contributor to run `/clear` followed by `/sf-initiative-next`; for `compact`, ask for `/compact` first. Do not author the next initiative phase in the old conversation.

If `ask_user` is unavailable or disabled, stop without approval. Every approval creates and pushes its own commit. Never describe self-approval as independent review.
