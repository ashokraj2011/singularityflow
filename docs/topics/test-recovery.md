---
id: test-recovery
title: Story test policy and phase recovery pilot
aliases:
  - trp
  - test-and-recovery-agreement
commands:
  - story
  - precheck
  - recover
related:
  - story-lifecycle
  - recovery
  - approvals
  - configuration
version: 1
---
Test and Recovery (TRP) is an explicitly enabled pilot for a Story's test policy, baseline repair and phase issues. It keeps what a check observed separate from the decision about whether work may continue. A failed test remains failed even when a current, authorized exception permits a named transition. Normal phase approval remains separate.

The currently enabled production routes are bounded readiness repair and reviewed test selection. Production risk acceptance and same-Story policy amendment are not enabled by this pilot.

## Purpose and prerequisites

An approved repository configuration must explicitly enable `testRecovery`. Installing a new runtime or opening intake does not opt an existing Story into a more permissive policy. Existing Stories keep their pinned behavior until an available governed amendment is reviewed and recorded. An absent, unknown or disabled capability does not authorize narrower testing or risk acceptance.

For a new Story, add this top-level block to the approved workflow definition through the repository's normal configuration-change process, then activate the configuration before opening intake:

```yaml
testRecovery:
  enabled: true
  enabledRiskCategories: []
  allowEvidenceReuse: false
```

Keep test commands structured (`kind: test`, explicit argv and a supported report contract). This opt-in does not infer a waiver for old string commands or change an already-started Story. A runnable example must use the repository's actual test command and report format, not a generic placeholder runner.

The VS Code intake section appears only when exact-base preflight advertises the pilot for the selected workflow. Non-code workflows do not gain a unit-test obligation merely because recovery is enabled. Unsupported choices stay visibly unavailable. The engine revalidates the selected base, workflow and policy at mutation time.

## Use it from each surface

- **Shell:** inspect `singularity-flow story test-policy show <WORK-ID> --json`. For bounded repair, use `singularity-flow story test-policy repair <WORK-ID> --plan --json`. For pre-Story evidence, use `singularity-flow precheck --run --scope dependency-test --json`. These previews execute no test; execution requires the returned exact confirmation.
- **Copilot:** `/sf-start` presents independent intake choices; `/sf-ready` reviews baseline acquisition; `/sf-recover` follows the engine's current repair actions. `/sf-approve` retains its separate approval-only boundary.
- **VS Code:** the Start Work form shows the pilot only when the engine advertises it. Review the observed baseline and the complete plan, then use its explicit confirmation control. Unsupported choices remain unavailable.

## Guided workflow

### Intake choices and baseline scope

Existing-failure disposition and ongoing test scope are independent. Choosing **Changed and affected tests** does not accept failures. Choosing **All configured tests** refers to the declared inventory; it does not promise that every test in a repository has been discovered. A unit-only inventory covers configured unit tests.

The initial intake pilot supports **Fix existing failures before feature coding**. It reuses only authenticated compatible baseline evidence for the exact selected base; failing or unknown readiness requires the returned repair route. **Accept listed existing failures** is unavailable in intake until a supported governed decision route can establish human authority for the exact failures. A local precheck acceptance is not a portable Story exception. Unknown or unobserved failures are always reported as unknown.

Baseline acquisition is separate from ongoing scope. Opening the form or refreshing its preview runs no test command and installs no package. To acquire evidence, inspect `singularity-flow precheck --run --scope dependency-test --json`, review its exact commands and plan digest, then use the returned exact-confirmation execution route. A full baseline requires a separate explicit choice; affected testing does not hide a full run. The intake pilot does not directly execute targeted or full baseline acquisition.

Before starting, review the exact plan: repository bases, requested and effective scope, tools, selected tests or suites, exclusions, unknowns, later mandatory checks and initial repair/coding route. Explicitly confirm its digest. Display defaults are not consent. A changed Story, repository, workflow, base or plan invalidates confirmation.

### Repair admission and checkpoint

A failing or unknown baseline may admit the Story into bounded readiness repair when the engine returns that route. Feature preparation and code generation remain blocked until every required code-bearing repository has passing readiness or a currently verified applicable decision. One repository's acceptance does not cover another. Intake and document phases can continue within their existing obligations.

The repair scope is bounded to reviewed readiness changes, not feature implementation. The command pilot supports one required code-bearing repository, runtime-only repair, conventional top-level project notes, added tests, and Node dependency/lock repair that preserves manifest scripts and other execution configuration. It refuses product-source edits, changed/removed/renamed baseline tests or fixtures, new manifests and unclassified runner/configuration changes. Legitimate fixes outside this narrow scope need a separately supported governed scope; the pilot does not claim to handle every repair. Test-only or setup-only repair needs no fabricated product-source edit. Do not delete tests, lower assertions, add blanket skips or edit protected configuration merely to obtain a pass.

Review the current repair checkpoint, both endpoints of every changed path, and the exact dependency/test execution plan. If source is dirty, review and commit only intended repair paths separately; this command never stages source or cleans files. A ready preview returns a single action: `singularity-flow story test-policy repair <WORK-ID> --repository <REPOSITORY-ID> --run --confirm <EXACT-DIGEST> --json`. That digest binds the agreement, source diff, checkpoint, prior readiness and commands. A changed plan needs fresh review.

Execution uses the existing bounded readiness runner. Completion requires a complete passing receipt at the reviewed checkpoint, including a successful process and current structured report. A known original baseline must retain its complete testcase identities and execution contract; matching totals alone cannot prove retention. Missing, ambiguous or truncated identities, skipped formerly failing tests, nonzero process exit, missing reports, duplicate results or stale source cannot complete repair.

The command records a passing assessment through the normal governed Story transaction, appending its raw receipt and checkpoint. It preserves the original baseline and source reference and records the repaired checkpoint as the feature-generation base. Initial baseline readiness is admission evidence only. It is not proof that the later feature candidate passed publication or submission tests. After a runtime-only repair, a fresh verified readiness result may legitimately qualify an unchanged source commit.

## State and safety

Inspect the engine's current test-policy, phase-risk or recovery result. Follow the exact returned legal action. A blocker should identify its stable issue ID, observation, disposition, preserved work, owner and repair/review route. Unavailable external prerequisites remain explicit; the agent must not invent a successful repair.

Risk review requires a substantive human reason, exact-plan confirmation, the applicable pinned authority and a durable decision receipt. An actor label, Git name, selected checkbox or exhausted repair budget is not proof of authority. Unsupported exception categories remain unavailable even if a client sends a flag. Known failures cannot be matched by counts alone; new failures, changed test meaning, missing identities or uncertain environments require a separate evaluation.

An accepted risk cannot waive identity, evidence provenance, protected-path authority or execution safety. An unavailable check stays unavailable; a skipped or excluded test is not passed. Evidence reuse must be explicitly qualified and displayed with its originating run. Moving the agreement to another host does not prove that tests ran there.

Selection consent is host-local and distinct from portable policy or evidence: a confirmation made in one checkout does not silently authorize a wider run on another host. Review the locally computed exact cohort and expansion again. The core evaluator and admission boundary remain authoritative; a UI state, copied receipt, selected default or agent-authored record cannot substitute for authenticated evidence, current authority or a governed commit.

The selection pilot can narrow understood direct Node test and Jest file commands. Pytest is currently module/suite-only: `PYTEST_ADDOPTS` and configuration `addopts` can add test roots beyond a file argument, and those collection inputs are not yet qualified for precise selection. Package scripts and other unsupported precise runners likewise require the disclosed module or full-suite expansion review. Explicit Node preload hooks also require expansion review. Inherited `NODE_OPTIONS` is not supported for any pilot test execution because it can preload extra tests; remove it from the invocation environment and review a fresh plan. Recognized legacy test commands must first declare a structured `kind: test` contract; they cannot run as an undisclosed extra quality gate.

Preserve owned drafts and published generations. A supported post-publication repair creates a successor generation; a permitted policy-only amendment preserves content and advances its validation requirements. Never use blanket reset, clean, stash, deletion or a commit of unrelated paths as recovery. An unchanged failure stops automatic retries. Verified runtime repair can justify a bounded retry without a source edit. Budget exhaustion opens a human decision and never accepts risk automatically.

A recorded commit awaiting push remains publication-pending. Resume that exact transport transaction; do not manufacture a second approval, decision or generation. A failed screen refresh after a committed change is a presentation warning, so re-read authoritative state.

## Troubleshooting

This implementation does not claim completion of all TRP v1.0 release acceptance criteria. The pure record/evaluation contract is broader than the operations each installed engine can authenticate and execute. Read the advertised capability and returned legal actions before using a route. Unsupported adapters, precise selectors, exception categories, amendment routes and baseline acquisition modes must fail closed or stay unavailable.

In particular, the production known-failure observation/decision path is not fully integrated across lifecycle gates. The schema and evaluator alone do not make intake acceptance executable. Multi-repository readiness repair, arbitrary assertion/product fixes, and targeted/full baseline acquisition from intake remain unavailable in this pilot. A missing route is a stated limitation, not consent to use a different command or edit workflow records by hand.

Passing local tests qualify the host on which they ran. Simulated Windows paths or platform flags do not establish native Windows qualification. macOS, Linux and Windows results must be reported independently; no cross-host execution evidence equivalence is implied by matching test names.

## Related topics

Continue with `singularity-flow explain recovery`, `singularity-flow explain story-lifecycle`, `singularity-flow explain approvals`, or `singularity-flow explain configuration`.
