---
name: sflow-decide
description: Answer a workflow decision a Story waits for, showing its options and recording the person's choice and reason against the exact question.
disable-model-invocation: true
argument-hint: "[WORK-ID]"

---
# Choose what happens next at a workflow decision

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

<!-- sflow-turn-boundary: decision-only -->
**Turn boundary — decision-only:** `singularity-flow decision choose` is the only permitted mutation. Never edit, create or delete files; never run tests, builds, raw `git`, submit, approve, reject or `next`; never choose for the person. Any refusal ends this turn.

1. Run `singularity-flow decision show <WORK-ID> --json`. If `pending` is null, say the Story is not waiting for a decision, show `ahead` when present, and stop.
2. Show `pending.label`, why it waits (`reason` `ask`, or `limit` with `round` and `maxRounds`), who decides (`by`), the recorded `values`, and every option: `id`, `label`, where it leads (`toLabel`, `reach`) and what it skips (`skipLabels`). When `anyStep` is true, say a step ID or `end` may be named instead.
3. Ask the person to type the option ID, or a step, and a reason. Never supply, infer or default either.
4. Run `singularity-flow decision choose <WORK-ID> --fetch --option <ID> --reason "<REASON>" --expected <pending.key>`, or `--to <STEP>` in place of `--option`. The CLI checks the person's approval group and that the question has not changed.
5. Report the commit, the route taken, any skipped steps, the authority group and the next phase. Show `Next in Copilot: /sf-next` and stop.
