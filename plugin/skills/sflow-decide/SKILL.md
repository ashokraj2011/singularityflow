---
name: sflow-decide
description: Answer a workflow decision a Story waits for, whether a left-out responsibility applies, a scope statement's disposition or a scope completeness review, recording the person's choice and reason.
disable-model-invocation: true
argument-hint: "[WORK-ID]"

---
# Choose what happens next at a workflow decision

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: governed-review -->
**Output contract:** Present artifact references, hashes, identity warnings, and the exact confirmation before recording any decision. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

<!-- sflow-turn-boundary: decision-only -->
**Turn boundary — decision-only:** `singularity-flow decision choose`, `singularity-flow decision applicability`, `singularity-flow decision scope`, `singularity-flow decision completeness` and `singularity-flow decision plan` are the only permitted mutations. Never edit files, run tests, builds, raw `git`, submit, approve, reject or `next`, or choose for the person. Any refusal ends this turn.

1. Run `singularity-flow decision show <WORK-ID> --json`. If `pending` is null and every `applicability` entry is `satisfied`, say the Story is not waiting for a decision, show `ahead` when present, and stop. If only `applicability` is open, go to step 6.
2. Show `pending.label`, why it waits (`reason`, `round`, `maxRounds`), who decides (`by`), `values`, and every option: `id`, `label`, `toLabel`, `reach`, `skipLabels`. With `anyStep`, a step ID or `end` may be named instead.
3. Ask the person to type the option ID, or a step, and a reason. Never supply, infer or default either.
4. Run `singularity-flow decision choose <WORK-ID> --fetch --option <ID> --reason "<REASON>" --expected <pending.key>`, or `--to <STEP>` in place of `--option`. The CLI checks the person's approval group and that the question has not changed.
5. Report the commit, route, skipped steps, authority group and next phase. Show `Next in Copilot: /sf-next` and stop.
6. For each `applicability` entry not `satisfied`, show `responsibility`, `declaredReason` and who decides (`authority`). Ask the person why it does not apply to this Story; never supply one. Run `singularity-flow decision applicability <WORK-ID> --fetch --responsibility <RESPONSIBILITY> --reason "<REASON>"`, report the commit, and stop.
7. Scope statements: run `singularity-flow evidence scope <WORK-ID> --json`. For each `unresolved` item show `id`, `text` and `sourceId`; ask the person for a disposition (clauses for included or existing) and a reason, never supplying either. Run `singularity-flow decision scope <WORK-ID> --fetch --item <ID> --as <DISPOSITION> [--clause <IDS>] --reason "<REASON>"`.
8. Completeness review, only when `structurallyComplete` is true: show `inventorySha256` and ask the person to answer each article (completeness, ambiguity, consistency, verifiability, boundary-conditions, non-functional) as satisfied, exception or not-applicable, with what they assessed. Run `singularity-flow decision completeness <WORK-ID> --fetch --confirm <inventorySha256> --article <ID>=<DECISION>... --reason "<REASON>"`. Say it records a review, never that the scope is correct.
9. Unplanned path: ask which row it belongs to, or its supporting class and why. Run `singularity-flow decision plan <WORK-ID> --fetch --add-location <CLAUSE>=<PATH> --reason "<REASON>"`.
