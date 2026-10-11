---
name: sflow-code
description: Author a code-generation phase with executable tests and exactly-once publication.
disable-model-invocation: true
argument-hint: "[code-generation focus]"

---
# Governed code

<!-- sflow-copilot-pause -->
First run `singularity-flow phase enter --for-agent --json` once. Lookup from current cwd (non-Git allowed). Never search `/Users`, `$HOME` or parents for a repo. Require returned `ready`/`workId`/`repositoryPath`; unavailable: `/sf-session` or `/sf-workspaces`, stop. It checks pause before Git. If `paused`, native Copilot; only offer `/sf-pause off`, never resume implicitly. Otherwise follow `agentGuide.readOrder` once, reuse binding/recovery/clarification/references and delivered inputs; no duplicate lookups. Read `clarification.checkpoint`: missing answers permit questions, not drafting. Never ask users to supply questions or slice control instructions. Use `personalization.replyName` literally in replies, never artifacts or approval identity.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, valid `phaseAgent`; cwd=`repositoryPath`. Honor `mutationContract`. Returned `workItemRoot`/artifact paths only; never `$HOME`.
Blocked: relay `resolution.issues[].choices` too. Eligible risk needs reason/expiry and authorized human confirmation. Never auto-accept risk.

1. Require entry `phase`, `phaseAgent.valid: true`, `generatesCode: true`, `authoring.policyVerified`. Relay other routes; never draft sign-off. No duplicate pause/session/status.
2. Review `recovery`, `intent`, test handoff and exact diffs/untracked bytes including `workflow.json`. `contextAdmission.pendingEvidence`: preserve held files/index; continue verified draft repairs, never accept evidence; contract review precedes publication. Otherwise stop on protected/unrelated/unowned edits or lifecycle/authority blockers. Repair owned open-intent actions; runner repair requires `CODE_DELIVERY_TEST_COMMAND_REQUIRED`. Untracked `.sflow/results/**` need no cleaning; review tracked/staged reports. Consumed-changed intent needs reviewed rollover; unchanged publication: relay `next`, stop.
3. Run `singularity-flow phase enter <phase> --work-id <WORK-ID> --compose --for-agent --json` once. Use `context.text`. `contextComposition: not-admitted`: relay `contextAdmission.blockers`/`next`, stop; no blind retries. Never infer `--task`.
4. `clarification.checkpoint`: `off` skips; `when-needed` asks material ambiguities; `required` derives evidence-grounded questions or confirms interpretation. `ask_user`: wait for answers; record before code mutation, never promises; unavailable: show questions and stop. Stage `{"responses":[...]}` at `clarification.responseStagingPath`; `singularity-flow clarification record <phase> --response-file <that-path>`. Delete on success; never in Story context or pass Markdown.
5. Use verified `references.repositories[].localPath`; refuse invalid/dirty. `singularity-flow revision status --json` only when `generation > 0`; first-generation authoring creates that candidate. Require an open intent; absent: `singularity-flow phase begin <phase> --json`, honoring adoption/confirmation. Consumed intent requires `/sf-recover`.
6. Implement code/tests, not README. Doc-comment APIs; tags are not docs. Exclude fixtures/docs/deletions/symlinks. In the planned product-source path: `// @clause:ORDER:REQ-001 rationale` (`REQ|BEH|IFC|AC|CON`); executable tests: `// @ac:ORDER:AC-001` above its test. Honor pinned test-only planned-claims opt-outs.
7. Intake tests advisory. Follow `testExecution.handoff`: ready + `argvWithheld: true` means configured, hidden argv—not missing. No adoption/amendment for redaction/inference. Publication runs resolved tests/fresh reports; no duplicate pre-run. Missing/invalid/ambiguous/policy-blocked runner: returned recovery/adoption. No skip/list/dry-run/no-tests. Submission runs fresh tests. Authorized dependencies only; never edit protected config, disable hooks or fabricate results.
8. Run `singularity-flow phase prepublish <phase> --for-agent --json` (includes draft-check). Obey `correction.class`/`sameTurn`, `traceabilityRepair.actions`: verify behavior/assertions/hashes; repair owned tags without per-tag confirmation. Implement missing behavior; clarify ambiguity. Publication runs fresh tests for repaired code. Repair other agent findings. Never invent, pad, blindly delete markers, nest models or overwrite producers. `ready` is not test success. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
9. Use returned `commands.publish` once when `ready`; required tests continue publication on success. Absent: relay `commands.next`, stop. On refusal report `requiredTestExecution`: command ID (not shell command), argv/cwd, exit, bounded stderr and guidance; hidden argv is not missing configuration. Nonzero exit fails despite passing JUnit. Follow `/sf-recover`; proven runtime repair permits retry without source changes. Source mutation requires review/rollover when consumed. `ARTIFACT_AUTHORING_INCOMPLETE`: recheck once, retry once. Never submit/approve.
10. `singularity-flow phase show <phase> --for-agent --json`: viewing only; bounded preview/hash-bound references/handoff.

TRP: `singularity-flow explain test-recovery`.
