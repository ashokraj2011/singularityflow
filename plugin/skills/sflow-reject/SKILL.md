---
name: sflow-reject
description: Request changes to a submitted or completed Story as the current Git identity, recording a structured comment, target phase, human authority group, governed agent, invalidation, commit, and push. Use when a stakeholder disagrees with an artifact, approval, or completed result and wants work returned to an allowed phase.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--fetch] --to PHASE --reason 'explanation'"

---
# Request governed changes

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision.

Sequence gates may be hard or soft. On `Out of sequence`, stop immediately and relay the error. On `Soft sequence warning`, show the full warning and leave the interactive `continue` decision to the human; never self-confirm. Use `singularity-flow nextsteps` only for read-only guidance and never edit managed state to bypass a gate.

1. Read status first. Show the current phase, artifact hashes, allowed `rejectTo` targets, reviewer Git identity, authority group, and governed agent.
2. Require a specific rejection reason and target phase; do not invent either. Present only the allowed targets, then preserve the human's exact comment.
3. For a phase awaiting approval, run `singularity-flow reject <phase> --work-id <WORK-ID> --fetch --to <earlier-phase> --reason "..."`.
4. For a completed Story, run `singularity-flow reopen <WORK-ID> --fetch --to <phase> --reason "..."`.
5. Stop on an unauthorized identity, disallowed target, disabled post-completion reopening, stale branch, or pending publication. Changing agents never grants decision authority.
6. Show which approvals and later phases will be invalidated before recording the decision.
7. Report the change-request ID, comment, human identity, authority group, governed agent, reopened target, invalidated phases, commit, and push.
8. Stop after recording the request. Do not modify artifacts unless the user separately asks to address it.
