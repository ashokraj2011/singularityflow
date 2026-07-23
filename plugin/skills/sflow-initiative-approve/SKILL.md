---
name: sflow-initiative-approve
description: Review exact initiative output or phase-bundle hashes and record an authorized approval from GitHub Copilot.
argument-hint: "<OUTPUT-ID|phase> [--initiative INIT-ID]"
disable-model-invocation: true
---
# Approve an initiative output or phase

Approval authority comes from configured local Git name/email groups, not the selected persona. Report identity assurance as `configured-local`, never cryptographic authentication.

1. Use `/sflow-initiative-documents` and `/sflow-initiative-checklist` to display full outputs, exact hashes, evidence assurance/freshness, prior approvals, child milestones, and self-approval risk.
2. Run `singularity-flow initiative choices begin approve <INIT-ID> <OUTPUT-ID|phase> --json`.
3. Present the persona choice with Copilot's `ask_user`; anyone may select any configured persona, but it does not grant approval authority.
4. Show the exact `phase:subject` confirmation option and require the reviewer to choose it explicitly. Never infer, preselect, or synthesize approval intent.
5. Record the two answers with `singularity-flow initiative choices answer <TOKEN> <CHOICE-ID> <SELECTED-ID> --json`.
6. Only after `ready: true`, run `singularity-flow initiative approve <OUTPUT-ID|phase> --initiative <INIT-ID> --selection-receipt <TOKEN>`.
7. Report the approved content/bundle hash, actor identity, authority group, persona, self-approval warning, remaining distinct approvals, advancement, commit, and push.

If `ask_user` is unavailable or disabled, stop without approval. Every approval creates and pushes its own commit. Never describe self-approval as independent review.
