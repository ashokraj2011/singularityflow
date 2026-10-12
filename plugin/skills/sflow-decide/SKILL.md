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
**Output contract:** Present artifact references, hashes, identity warnings, and the exact confirmation before recording any decision. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

<!-- sflow-turn-boundary: decision-only -->
**Turn boundary — decision-only:** `singularity-flow decision choose|applicability|scope|completeness|plan` and `singularity-flow upstream-issue decide` are the only permitted mutations. Never edit files, run tests or builds, raw `git`, submit, approve, reject or `next`. The person types every choice and reason; never supply, infer or default one. Any refusal ends this turn.

1. Run `singularity-flow decision show <WORK-ID> --json`. Act on what it returns open (`pending`: step 2; unsatisfied `applicability`: 6; `upstreamIssues`: 10) and on the routed scope, completeness or plan command (7-9); none: say nothing is waiting, show `ahead`, stop.
2. Show `pending.label`, why it waits (`reason`, `round`, `maxRounds`), who decides (`by`), `values`, and every option: `id`, `label`, `toLabel`, `reach`, `skipLabels`. With `anyStep`, a step ID or `end` may be named instead.
3. Ask for the option ID, or a step, and a reason.
4. Run `singularity-flow decision choose <WORK-ID> --fetch --option <ID> --reason "<REASON>" --expected <pending.key>`, or `--to <STEP>` in place of `--option`.
5. Report the commit, route, skipped steps, authority group and next phase; show `Next in Copilot: /sf-next`; stop.
6. For each `applicability` entry not `satisfied`, show `responsibility`, `declaredReason` and who decides (`authority`); ask why it does not apply. Run `singularity-flow decision applicability <WORK-ID> --fetch --responsibility <RESPONSIBILITY> --reason "<REASON>"`; report the commit; stop.
7. Scope statements: run `singularity-flow evidence scope <WORK-ID> --json`. For each `unresolved` item show `id`, `text` and `sourceId`; ask for a disposition (clauses for included or existing) and a reason. Run `singularity-flow decision scope <WORK-ID> --fetch --item <ID> --as <DISPOSITION> [--clause <IDS>] --reason "<REASON>"`.
8. Completeness review, only when `structurallyComplete`: show `inventorySha256`; ask for each article (completeness, ambiguity, consistency, verifiability, boundary-conditions, non-functional) as satisfied, exception or not-applicable. Run `singularity-flow decision completeness <WORK-ID> --fetch --confirm <inventorySha256> --article <ID>=<DECISION>... --reason "<REASON>"`. A review, never proof the scope is correct.
9. Unplanned path: ask for its row, or its supporting class and why. Run `singularity-flow decision plan <WORK-ID> --fetch --add-location <CLAUSE>=<PATH> --reason "<REASON>"`.
10. Upstream issues from step 1: show each `id`, `phase`, `about`. Outcomes: plan-correction (`--link PRC-NNN`), return, accept-risk (`--expires YYYY-MM-DD`) or dismiss. Run `singularity-flow upstream-issue decide <UPI-ID> --work-id <WORK-ID> --outcome <OUTCOME> --reason "<REASON>"`.
