---
name: sflow-initiative-approve
description: Review exact initiative output or phase-bundle hashes and record an authorized approval from GitHub Copilot.
disable-model-invocation: true
argument-hint: "<OUTPUT-ID|phase> [--initiative INIT-ID]"

---
# Approve an initiative output or phase

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision.
<!-- sflow-execution-boundary -->
**Boundary:** Flow-reported root only (Story: `singularity/work-items/<WORK-ID>/`). Deterministic: `--no-model`; kernel model: forbidden.

Approval authority comes from configured local Git name/email groups, not the selected agent. Report identity assurance as `configured-local`, never cryptographic authentication.

1. Use `/sf-initiative-documents` and `/sf-initiative-checklist` to display full outputs, exact hashes, evidence assurance/freshness, prior approvals, child milestones, and self-approval risk.
2. Run `singularity-flow initiative choices begin approve <INIT-ID> <OUTPUT-ID|phase> --json`.
3. Present the governed-agent choice with Copilot's `ask_user`; anyone may select any configured agent, but it does not grant approval authority.
4. Show the exact `phase:subject` confirmation option and require the reviewer to choose it explicitly. Never infer, preselect, or synthesize approval intent.
5. Record the two answers with `singularity-flow initiative choices answer <TOKEN> <CHOICE-ID> <SELECTED-ID> --json`.
6. Only after `ready: true`, run `singularity-flow initiative approve <OUTPUT-ID|phase> --initiative <INIT-ID> --selection-receipt <TOKEN>`.
7. Report the approved content/bundle hash, actor identity, authority group, governed agent, self-approval warning, remaining distinct approvals, advancement, commit, and push.
8. When phase approval advances the initiative, reproduce the CLI's context-boundary guidance. For `new`, stop and ask the contributor to run `/clear` followed by `/sf-initiative-next`; for `compact`, ask for `/compact` first. Do not author the next initiative phase in the old conversation.

If `ask_user` is unavailable or disabled, stop without approval. Every approval creates and pushes its own commit. Never describe self-approval as independent review.
