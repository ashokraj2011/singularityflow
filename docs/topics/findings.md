---
id: findings
title: Findings — what a blocking finding means and how to recover
aliases:
  - finding
  - blocking-finding
  - refusal-codes
questions:
  - What does this finding code mean?
  - Why is my phase blocked and who can fix it?
  - The check is wrong; how do I get past it?
commands: []
related:
  - recovery
  - phase-appeals
  - escalation
version: 2
---
A finding is one exact reason a step cannot publish, submit or finish. Every finding has an owner and a recovery route: the step's own author fixes its draft, an earlier step's approvers decide an upstream issue, a person records a decision, or an owner restores trusted bytes. Each refusal names its finding code; read its entry here with `sflow explain findings --section <CODE>` (the code is matched without regard to case). Nothing in this catalog waives a test, approves a step or accepts a risk by itself.

## Purpose and prerequisites

Use this topic when a step was refused and you need to know what the finding means, what usually causes it, how to fix it, and who else can act when the author cannot. Run `sflow recover --phase <PHASE> --json` first: it lists the step's current findings with their routes, and preserves every draft, index entry and published byte.

## Use it from each surface

- **Shell:** `sflow explain findings --section <CODE>` for one entry; `sflow recover --phase <PHASE> --json` for the live findings and routes.
- **Copilot:** `/sf-recover` lists the routes; `/sf-help` serves this topic. A skill follows the route it was given and never edits an earlier step to clear a finding.
- **VS Code:** the refusal card names the finding and its route; open **Lifecycle** to act on it.

## Guided workflow

1. Read the finding's code and route from the refusal or from `sflow recover --phase <PHASE> --json`.
2. Read its entry below: what it means, the usual causes, and the fix.
3. Fix what the entry says the author owns, then recheck with `sflow phase prepublish <PHASE> --json`.
4. When the author cannot fix it (the finding belongs to an earlier step, a person must decide, or the check misreads correct work), use the route its entry names for someone else instead of repeating the same repair.

## Finding classes

Every finding belongs to one class. A finding without its own entry below is documented by its class.

### author-correction

The step's own author fixes its current draft: the artifact, its tags, its tests or its planned evidence. Fix the listed item in the open generation and recheck with `sflow phase prepublish <PHASE> --json`. Published content needs a successor generation, never an edit in place. If the same finding returns unchanged after a real repair, stop repeating it: the check may be misreading correct work. Where its entry offers a dispute, prepare one with the evidence; otherwise name the finding and its evidence to the step's approvers.

### quality

A document-quality shortfall, such as a placeholder left in, a required section that is too short, or an empty heading. The author fixes it in the draft. For a pilot phase, the step's approvers may instead carry the exact shortfall forward with an expiry through `sflow appeal risk-prepare`; it stays unmet, never passed, and tests, review and approval still apply.

### upstream-defect

An honest check found that an earlier step's delivery is incomplete. Do not edit the verdict or the earlier step. Raise an upstream issue with `sflow upstream-issue raise --phase <EARLIER-STEP> --about <CLAUSE> --problem <TEXT>`; that step's approvers decide it (return, amendment, plan correction or accepted risk).

### integrity-or-authority

A protected path, an identity, a signature, a configuration authority, a source boundary or a secret check refused. These protect the Story and cannot be waived by an appeal or a risk decision. Preserve your edit, then restore the trusted bytes or use the original configuration authority; `sflow doctor --json` shows what changed.

### current-phase-preparation

The current generation is not prepared yet: no composed prompt, no open generation intent, or grounding not ready. Prepare it (`sflow wm compose --phase <PHASE>` or `sflow phase begin <PHASE> --json`) and recheck. Existing work is kept.

### worktree-review

Uncommitted or staged changes need review before the step can continue. `sflow recover --phase <PHASE> --json` shows the exact bytes and can offer a hash-confirmed scoped commit; unrelated edits and the index are preserved.

### human-input

A person must answer a clarification. Ask the question, then record the actual reply with `sflow clarification record <PHASE> --question <TEXT> --answer <TEXT>`. A missing record is not an unanswered question, and an answer is never invented.

### operational-prerequisite

The environment, a host, a remote, an integration or the test runner is unavailable. The step's work is fine; resolve the prerequisite with its owner (`sflow doctor --json` names it), then retry. Retrying an unchanged condition changes nothing.

### lifecycle

The Story or step is not in a state that allows this transition. Resume it, prepare a successor, or follow the route the refusal names.

### owner-resolution

No automatic repair or decision is registered for this finding. Give the workflow maintainer the exact finding and the output of `sflow doctor --json`; nothing is discarded while it waits.

## Finding catalog

### CODE_DELIVERY_EVIDENCE_REQUIRED

The code step's delivery is not publishable: no product source changed, no acceptance test was found, owed `@ac` or `@clause` tags are missing, or a fulfillment obligation is unmet. Common causes: a test that does not run, tags on the wrong line or naming a criterion the specification does not hold, or a test file outside every recognised test folder (the refusal names such a file). Fix the listed items in the open generation and recheck with `sflow phase prepublish <PHASE> --for-agent --json`. When every item is delivered and the finding still returns unchanged, the check is misreading the delivery: stop the repair loop and dispute it. `sflow appeal risk-prepare --phase <PHASE> --finding CODE_DELIVERY_EVIDENCE_REQUIRED --evidence-file <PATH> --expires <YYYY-MM-DD> --reason <TEXT>` binds the exact problems, this candidate and the evidence (test output, the test file); one of the step's approvers reviews it live with `sflow appeal risk-accept` and the same arguments plus `--confirm`. The gate then publishes this exact candidate with the finding recorded as an exception, never as passing evidence; tests still run, and any change to the candidate or a new problem ends the exception. `sflow appeal risk-revoke` withdraws it.

### CODE_DELIVERY_RETAINED_EVIDENCE_MISSING

A planned evidence file (usually a screenshot) has not been produced. Start the app from the Story's own checkout on a port you confirmed is free, bring it to the planned state and save the file at exactly the planned path, then recheck. Never take it from another checkout's server and never fabricate it; a person witnesses it after submission.

### CODE_DELIVERY_TEST_COMMAND_REQUIRED

No supported structured test command can be inferred for the changed code. `sflow capability test-setup --json` suggests one; repair the repository's own test script within the step's scope. An explicit command needs a reviewed policy amendment.

### SPEC_COVERAGE_INCOMPLETE

A clause the step owes has no evidence, a changed path is not claimed by any clause, or recorded evidence is invalid. Add the missing evidence in the draft. An unplanned path is accounted for by the plan's approvers (`sflow decision plan <WORK-ID> --add-location <CLAUSE>=<PATH> --reason <TEXT>`) or through a scope appeal (`sflow appeal prepare`). Missing coverage on a pilot phase may be carried as an expiring risk by the step's approvers.

### Unclaimed changed paths

A file changed that no clause claims, such as a test helper, mock data or a new module. Each changed path belongs to a clause row: tests in the Planned tests column, product files under Expected paths. The plan's approvers add it with `sflow decision plan <WORK-ID> --add-location <CLAUSE>=<PATH> --reason <TEXT>` or `--add-test <CLAUSE>=<PATH>`; while the code step is open, `sflow appeal prepare` accounts for it after review of the exact diff.

### Agent brief findings

`AGENT_BRIEF_SUMMARY_REQUIRED`, `AGENT_BRIEF_PRESERVED_SECTION_REQUIRED`, `AGENT_BRIEF_MAXIMUM_BYTES_EXCEEDED`, `AGENT_BRIEF_HEADING_AMBIGUOUS` and `ARTIFACT_COMMENT_UNCLOSED`. The Agent brief is not readable: write it as visible text under its own heading, outside any template comment, keep it within its size, close every comment, then recheck.

### Document quality findings

`artifact.placeholder.unresolved`, `artifact.required.too-short` and `artifact.heading.empty`. A template placeholder is still in the draft, a required section is too short, or a heading has no content. Complete the section in the draft and recheck; see the quality class above for pilot risk.

### conformance.verdict-incomplete

The conformance comparison is honest and found the delivery short. Keep the verdict. Record what the delivering step missed with `sflow upstream-issue raise --phase <DELIVERING-STEP> --about <CLAUSE> --problem <TEXT>`; this report publishes after that step returns and delivers the clause.

### Upstream input findings

`phase_inputs_not_ready`, `specification_index_untrusted` and `convergence_upstream_artifact_stale`. An approved input from an earlier step is missing, changed or not ready. Never edit it from this step: `sflow inputs <PHASE> --dry-run --json` shows it, a restorable input is restored to its approved bytes, and a needed change goes through the earlier step's return or amendment route.

### plan_evidence_correction_review_required

A pending evidence correction changes the plan's evidence contract. Keep the pending evidence; the plan's approvers review the contract change (`sflow appeal evidence-prepare`) before publication. No visual pass or test waiver is implied.

### Retained publication findings

Codes beginning `generation_publication`. A retained publication or its authored bytes no longer match what was published. Restore the authenticated bytes or prepare a reviewed successor; configuration refresh and risk acceptance cannot authenticate a changed publication.

### phase_quality_risk_pending_tests

Quality risk cannot be reviewed before this published generation's tests and observed claims are collected. Submit to collect them first; nothing is waived.

### generation.document.published-changed

A published document was edited after publication. Keep the new draft separately and restore the reviewed bytes, or, while the step awaits approval, ask its approvers for a return with `sflow reject <PHASE> --to <PHASE> --reason <TEXT>`.

### Claim binding findings

`specification_claim_map_binding_stale` and `specification_claim_map_binding_required`. The step's published claim binding is stale or missing. Restore authenticated bytes or rework through a reviewed successor; `sflow doctor --json` shows the binding.

### Repair attempt findings

`phase_repair_recheck_required` and codes beginning `phase_repair_journal`. A durable repair attempt is pending: resume it with `sflow appeal repair-resume --phase <PHASE> --json` instead of starting a new one. Never delete the repair journal to get a new budget.

### Generation intent findings

`GENERATION_INTENT_REQUIRED`, `generation_intent_already_consumed` and `generation.intent.consumed-changed`. Code may change only inside an open generation. Open it with `sflow phase begin <PHASE> --json` (existing work is kept); a consumed intent needs `sflow recover --phase <PHASE> --json` and a reviewed successor.

### Grounding findings

`phase.grounding.required` and `phase.grounding.not-ready`. The current generation has no trusted composition. Recompose it with `sflow wm compose --phase <PHASE>`; tampered authenticated records still need restoration.

## State and safety

Reading this topic changes nothing. A finding's route names who may act; a route is not authority, a successful check or an approval. Prior approvals stay immutable, published bytes are never edited in place, and no route discards work or accepts a risk automatically.

## Troubleshooting

- If the same finding returns after a real repair, stop: repeating an unchanged repair cannot pass. Use the route its entry names for someone other than the author.
- If a finding's code has no entry here, its class entry applies; `sflow recover --phase <PHASE> --json` shows the class.
- If an earlier step is wrong, never edit it from the current step; raise an upstream issue.
- If a protected or integrity finding appears, preserve your work and restore the trusted bytes; no appeal can waive it.

## Related topics

Continue with `sflow explain recovery`, `sflow explain phase-appeals`, `sflow explain escalation`.
