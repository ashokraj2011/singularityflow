---
name: sflow-epic-review-decision
description: Approve or reject one finalized Epic Story against its exact review-packet hash using Copilot choice receipts and auditable Git publication.
disable-model-invocation: true
argument-hint: "<EPIC-KEY> <STORY-KEY> <approve|reject> <PACKET-SHA256>"

---

# Decide an exact Story packet

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Require Epic key, Story key, decision (`approve` or `reject`), and the exact full packet SHA-256 previously displayed by `/sf-epic-review`.
2. Run `singularity-flow epic review-choice begin <DECISION> <STORY-KEY> --epic <EPIC-KEY> --packet <SHA-256> --json`.
3. Ask the user to select every returned choice:
   - current reviewer identity and matched approval authority group;
   - governed agent for prompt/audit context;
   - rejection target when rejecting;
   - exact packet confirmation.
4. Record each answer with `singularity-flow epic review-choice answer <TOKEN> <CHOICE-ID> <SELECTED-ID> --json`.
5. For rejection, require a meaningful reason.
6. Execute:
   - approve: `singularity-flow epic review approve <STORY-KEY> --epic <EPIC-KEY> --packet <SHA-256> --selection-receipt <TOKEN>`;
   - reject: `singularity-flow epic review reject <STORY-KEY> --epic <EPIC-KEY> --packet <SHA-256> --selection-receipt <TOKEN> --reason "<REASON>"`.
7. Show the Story commit, Epic aggregation commit, push results, and self-approval warning.

Never approve unless exact-SHA checks are ready and the reviewer identity is authorized. Never infer a governed agent, target, packet, or confirmation.
