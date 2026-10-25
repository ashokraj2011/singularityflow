---
id: test-recovery
title: Story test policy and recovery pilot
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
version: 25
---
Test and Recovery (TRP) is an explicitly enabled pilot for a Story's test policy, baseline repair and phase issues. It keeps what a check observed separate from the decision about whether work may continue. A failed test remains failed even when a current, authorized exception permits a named transition. Normal phase approval remains separate.

The available routes are bounded readiness repair, reviewed test selection, current-phase test-command amendment, exact intake baseline acceptance, native Node/pytest/Maven failure and skipped-coverage review, and explicitly designated supplemental-document exceptions. Verified in-scope draft changes receive concrete repair or successor-generation guidance. These are not blanket waivers for dirty worktrees or protected state.

## Shared evidence consistency account

Phase entry, reporting-phase draft/prepublication checks, phase document reviews, and approval
reviews expose the same `evidenceConsistency` read-only projection. Copilot composition and the
CLI/VS Code review displays use its shared summary. The projection is derived from verified
retained packets, current source bindings, recorded visual reviews, existing evidence-reuse
decisions and upstream-issue decisions; it is not another evidence database or approval receipt.

Each test run stays attributed to the phase and generation that retained it. A Verification
report claiming 15 passing tests is not substantiated by an earlier Implementation packet that
retains 33 passing tests, even on the same source. An authorized evidence-reuse decision can make
that earlier run applicable without turning it into a Verification execution. Missing or omitted
records, stale bindings and suite counts never become clause acceptance automatically.

The account also surfaces contradictory conformance verdicts, valid human visual reviews a report
denies, and legacy discrepancies filed against a phase other than the owner named in their source
item. These are reconciliation advisories, not new publication blockers or automatic decisions.
Use the existing draft repair, superseding upstream issue, evidence-reuse, risk decision or fresh
execution route as appropriate. Historical artifacts and immutable submissions are not rewritten.
Normal fresh lifecycle, evidence and human authority checks still run at mutation boundaries.

Reused generation prompts keep their exact persisted bytes. New observations are delivered beside
them as an evidence-consistency refresh, with a content digest and explicit omission counts.

## Purpose and prerequisites

An approved repository configuration must explicitly enable `testRecovery`. Installing a new runtime or opening intake does not opt an existing Story into a more permissive policy. Existing Stories keep their pinned behavior until an available amendment is reviewed and recorded. An absent, unknown or disabled capability does not authorize narrower testing or risk acceptance.

For a new Story, add this top-level block to the approved workflow definition through the repository's normal configuration-change process, then activate the configuration before opening intake:

```yaml
testRecovery:
  enabled: true
  enabledRiskCategories: []
  allowEvidenceReuse: false
```

Keep test commands structured (`kind: test`, explicit argv and a supported report contract). This opt-in does not infer a waiver for old string commands or change an already-started Story. A runnable example must use the repository's actual test command and report format, not a generic placeholder runner.

A ready runner handoff sets `repositoryEditsRequired: false`: it is an invocation contract, not a
request to edit the repository. For example, an ordinary `test: vitest run` package script already
resolves to a command with JSON reporter/output arguments. Do not add those flags to `package.json`
merely to produce the same report. Hidden approved arguments are also not missing configuration.
Actual unavailable runners still require the returned approved configuration route; a ready handoff
does not establish that tests ran or passed, and publication/submission owns fresh execution.

The VS Code intake section appears only when exact-base preflight advertises the pilot for the selected workflow. Non-code workflows do not gain a unit-test obligation merely because recovery is enabled. Unsupported choices stay visibly unavailable. The engine revalidates the selected base, workflow and policy at mutation time.

Capability onboarding can separately declare exact `sourceHashExcludedRoots` directories and
`testConfigurationPaths` files in `singularity/capabilities.yml`. They are pinned into a new Story's
capability resolution and independently fingerprinted for test evidence. They do not by themselves
select changed-only testing, accept a pre-existing failure, or enable this intake pilot.

## Use it from each surface

- **Shell:** inspect `singularity-flow story test-policy show <WORK-ID> --json`. For bounded repair, use `singularity-flow story test-policy repair <WORK-ID> --plan --json`. For pre-Story evidence, use `singularity-flow precheck --run --scope dependency-test --json`. These previews execute no test; execution requires the returned exact confirmation.
- **Copilot:** `/sf-start` presents independent intake choices; `/sf-ready` reviews baseline acquisition; `/sf-recover` follows the engine's current repair actions. `/sf-approve` retains its separate approval-only boundary.
- **VS Code:** the Start Work form shows the pilot only when the engine advertises it. Review the observed baseline and complete plan, then explicitly confirm. The current phase's **Test policy and recovery** action, or **Review Story Test Policy and Recovery** in the command palette, reads the policy and previews an approved runner amendment or missing local review origin. A returned review action stages the exact command in a terminal without pressing Enter; execute it yourself to begin live review. A UI selection is not human approval. Unsupported choices remain unavailable.

## Guided workflow

### Reviewed worktree commit and continuation

Untracked regular test reports under `.sflow/results/**` are preserved and do not block approval.
Tracked or staged reports, symbolic links and real authoring changes still need review.
For every resolved code-delivery phase (including custom/future workflows), recovery can offer
`commit-reviewed-worktree` with exact paths and a hash-bound command. Review those diffs and
explicitly confirm the current plan before `recover --commit-reviewed --confirm <planId>`.
It makes an authoring commit only: normal Git hooks/signing still apply, other staged work stays
untouched, no remote push occurs, and tests or publication/approval gates are not waived.
Follow the returned current phase actions. Changed published source needs an authenticated
successor/revalidation; a commit never makes an old submitted packet cover new code.
Changed bytes, HEAD or index invalidate confirmation. Pending publication must be recovered first.
Singularity Flow's own and protected files, other Stories, out-of-boundary paths and non-regular operations are not
swept into this commit. Their original recovery actions remain visible.

VS Code: **Test policy and recovery → Review and commit current code-phase edits** previews the
plan and prepares its exact command without pressing Enter. Copilot: `/sf-recover` offers the
commit option and waits for human consent. An approval refusal still ends its approval-only turn;
recover separately, then refresh the immutable packet review and consent.

### Test commands and configuration adoption

The engine may resolve a supported test command directly from the affected module's manifests.
`testExecution.commands[].argvSource: inferred` is not a missing policy or an approval blocker:
use the returned argv, working directory and structured reporter. Publication independently runs
the required tests and records their evidence. Only missing, invalid, ambiguous or explicitly
policy-blocked runners require configuration repair.

Configured commands are available even when read-only output shows `argv: null`:
`availability: ready`, `argvWithheld: true` and `argvSource: approved-configuration` mean the
arguments were deliberately withheld to avoid exposing positional secrets. Do not propose a
runner adoption or Story amendment just because those arguments are hidden.
`testExecution.handoff` identifies the execution owner and, only after readiness permits it,
the exact continuation command. Prepublish remains read-only. Publication executes the resolved
tests, validates fresh reports and continues publication when they pass; submission independently
executes its required checks and continues when they pass. There is no extra runner-configuration
decision or mandatory duplicate test run between those steps. Other findings, independent review
and required human approval remain separate. This contract follows code-delivery semantics,
including custom and future workflow phases, rather than a hardcoded phase name.

VS Code's main Navigator has **Configuration approvals**, opening Workflow Studio's **Changes**
queue for workflow, agent and test-configuration proposals. **Reviews** separately links both that
queue and **Setup & capability proposals**. Opening either list never approves anything.

Activating `sflow/config` does not replace an existing Story's saved policy. When an explicit
test-command adoption is needed, preview `story test-policy amend`, then have the authorized human
execute the returned exact apply command in a live terminal. At its confirmation prompt, type
`Amend test command`, or press Enter to cancel. Surrounding whitespace is ignored; the words and
case must still match. A mismatch explains the expected phrase and allows up to three attempts.
Live review cards and prompts use terminal stderr, so `--json` cannot buffer them out of sight;
stdout remains reserved for the command result. Copilot must never answer the human confirmation itself.

An open phase may contain an exact evidence file named for that phase in its approved, committed
planning claim map. Recovery classifies that bounded, regular, non-symlink file as current-phase
authoring, not unrelated work. This does not validate its contents or mark a test passed. Unknown
files, invalid plan bindings, unsafe paths and protected changes still require manual review.

### Intake choices and baseline scope

Existing-failure disposition and ongoing test scope are independent. Choosing **Changed and affected tests** does not accept failures. Choosing **All configured tests** refers to the declared inventory; it does not promise that every test in a repository has been discovered. A unit-only inventory covers configured unit tests.

Choose **Fix existing failures before feature coding** or **Accept listed existing failures** independently of ongoing scope. Acceptance requires approved `known-test-failure`, named risk authorities, independent case inventory, and a genuine authenticated baseline at the exact selected base. Summary-only precheck results are insufficient. Unknown or unobserved failures stay unknown; a checkbox is not consent.

Before Story creation, preview `singularity-flow story test-policy baseline <WORK-ID> --phase <PHASE> --repository <REPOSITORY-ID> --base <FULL-COMMIT> --work-type <WORKFLOW> --isolated-worktree --json`. Review its exact command and target checkout, then execute its returned `--run --confirm <DIGEST>` action. This prepares the managed Story checkout and captures tests there without creating a Story. The later isolated Start resumes that checkout; it never copies a launch checkout's execution proof. Only omit `--isolated-worktree` for an explicitly in-place CLI start. Retained output is preserved on failure, and an existing report is never silently overwritten.

Pass the resulting digest as `--test-baseline-record <RECORD-DIGEST>` on intake with `--test-baseline-disposition accept-known-failures`, `--test-baseline-reason`, `--test-baseline-owner`, `--test-baseline-remediation`, and `--test-baseline-expires-at <UTC-TIMESTAMP>`. Intake binds the exact failures, agreement, base, expiry and follow-up. A delegated human must review the live terminal cards; feature generation remains closed until the initial decision is durably published and any required push acknowledged. VS Code only stages that Start command without pressing Enter.

Required dependency, build and application-start checks are separate prerequisites. Intake authenticates their current readiness evidence independently. A genuine readiness run whose tests failed may still prove those other checks passed; an overall green test result is not demanded just to review known failures. A newer failed readiness baseline supersedes an older passing receipt. Missing, failed or stale non-test prerequisites cannot be accepted as test risk.

`baselineMutableRoots` in the approved case inventory may name non-root product-source directories, such as `src`. Only baseline compatibility ignores those approved source roots; every current run still binds the entire candidate. Tests, fixtures, manifests, installed dependencies, execution configuration, environment and toolchain must remain compatible. Without this declaration, carry-forward is unchanged-source-only. Matching identity, semantics and failure cause is bounded compatibility, not proof of causal equivalence; new or changed failures need new review. Baseline evidence is never relabeled as a current test run.

If admission expires or is revoked before coding, inspect `story test-policy baseline-admission <WORK-ID> --phase <PHASE> --repository <REPOSITORY-ID> --record-sha256 <BASELINE-DIGEST> --reason "Why admission remains appropriate" --follow-up-owner <OWNER> --remediation <REFERENCE> --expires <UTC-TIMESTAMP> --json`. The returned live review creates a new admission-only decision; it never revives a revoked grant or fabricates fresh execution. Incompatible or unavailable evidence requires fresh capture/repair instead.

Baseline acquisition is separate from ongoing scope. Opening the form or refreshing its preview runs no test command and installs no package. To acquire evidence, inspect `singularity-flow precheck --run --scope dependency-test --json`, review its exact commands and plan digest, then use the returned exact-confirmation execution route. A full baseline requires a separate explicit choice; affected testing does not hide a full run. The intake pilot does not directly execute targeted or full baseline acquisition.

Before starting, review the exact plan: repository bases, requested and effective scope, tools, selected tests or suites, exclusions, unknowns, later mandatory checks and initial repair/coding route. Explicitly confirm its digest. Display defaults are not consent. A changed Story, repository, workflow, base or plan invalidates confirmation.

### Repair admission and checkpoint

A failing or unknown baseline may admit the Story into bounded readiness repair. Alternatively, exact authenticated known failures can enter the separately reviewed risk-admission route above. Neither path admits unknown tests as passing. The current risk adapter binds one exact repository; one repository's evidence does not cover another. Intake and document phases retain their own obligations.

The repair scope is bounded to reviewed readiness changes, not feature implementation. The command pilot supports one required code-bearing repository, runtime-only repair, conventional top-level project notes, added tests, and Node dependency/lock repair that preserves manifest scripts and other execution configuration. It refuses product-source edits, changed/removed/renamed baseline tests or fixtures, new manifests and unclassified runner/configuration changes. Legitimate fixes outside this narrow scope need a separately supported scope; the pilot does not claim to handle every repair. Test-only or setup-only repair needs no fabricated product-source edit. Do not delete tests, lower assertions, add blanket skips or edit protected configuration merely to obtain a pass.

Review the current repair checkpoint, both endpoints of every changed path, and the exact dependency/test execution plan. If source is dirty, review and commit only intended repair paths separately; this command never stages source or cleans files. A ready preview returns a single action: `singularity-flow story test-policy repair <WORK-ID> --repository <REPOSITORY-ID> --run --confirm <EXACT-DIGEST> --json`. That digest binds the agreement, source diff, checkpoint, prior readiness and commands. A changed plan needs fresh review. The digest is exact-plan confirmation, the same contract as `precheck --run --confirm-plan`; it is not human authentication, and the preview reports `requiresHumanConfirmation: false` with `confirmationPolicy.kind: exact-plan-digest`. The returned action is marked `automatic`, so an agent may run it once without waiting for a person, because a repair records only an objective, complete passing receipt inside the bounded scope and accepts no risk. A refused feature admission (`TRP_FEATURE_ADMISSION_BLOCKED`) routes to the preview and then this action. Risk acceptance and baseline admission, which are consent decisions, still require the delegated reviewer in a live terminal.

Execution uses the existing bounded readiness runner. Completion requires a complete passing receipt at the reviewed checkpoint, including a successful process and current structured report. A known original baseline must retain its complete testcase identities and execution contract; matching totals alone cannot prove retention. Missing, ambiguous or truncated identities, skipped formerly failing tests, nonzero process exit, missing reports, duplicate results or stale source cannot complete repair.

The command records a passing assessment through the normal Story transaction, appending its raw receipt and checkpoint. It preserves the original baseline and source reference and records the repaired checkpoint as the feature-generation base. Initial baseline readiness is admission evidence only. It is not proof that the later feature candidate passed publication or submission tests. After a runtime-only repair, a fresh verified readiness result may legitimately qualify an unchanged source commit.

### Correct a pinned test command without discarding generated work

An approved configuration correction does not automatically update an existing Story. For the current code-delivery phase, inspect `singularity-flow story test-policy amend <WORK-ID> --reason "Explain the approved command correction" --json`. The command reads the newer approved configuration from the Story's original authority and previews its exact old/new test contracts. It does not run tests. The phase must still be in progress or awaiting approval; this route cannot reopen a completed Story or a prior completed phase.

This specific repair can also serve a Story with an accepted workflow-authority snapshot that did not opt into TRP. It does not add a Test and Recovery Agreement, narrow testing or enable risk acceptance; all existing obligations remain pinned.

This bounded route uses structured `kind: test` contracts, the existing source baseline and original generation intent. A Story with no explicit test command may adopt a newly approved structured contract; this is explicit reviewed adoption, not automatic trust in an inferred runner. Existing non-test commands remain unchanged. Ambiguous legacy string or inferred test declarations are not converted by this route. Commit only the intended application source and tests separately before review; the amendment does not stage application changes. Before first publication, the intent must remain open and an authored phase artifact may remain a draft. After publication, the consumed intent and exact published generation remain intact. The amendment preserves artifact bytes, the application tree, the original intent and baseline, and every existing snapshot. It appends a workflow-authority revision and advances the validation epoch; it does not restart the Story or rewrite previous policy records.

The reviewing human must satisfy both the original pinned phase authority and the newer approved configuration authority. The pilot supports one required human reviewer and unchanged approval policy and authority membership; it cannot grant itself authority, lower approval requirements or adopt unrelated workflow changes. Follow the exact returned `--apply --confirm <DIGEST>` action in a live terminal and review the displayed command difference. The digest selects the review; the flag alone is not approval. Changed source, draft, reason, authority or configuration requires a fresh preview and review.

Before first publication, resume the existing generation's normal publication route after the amendment commits. It must execute the corrected structured test command and produce fresh current evidence before publication succeeds.

For an already published current generation, the amendment retains its publication, previous validation receipts, submission packets and approval history. An awaiting-approval phase returns to in progress. Follow the normal submit route: it executes the corrected command against the unchanged generation, records fresh epoch-specific validation and creates a new immutable review packet. It does not fabricate a new content generation or relabel an old test run under the new command. Old-epoch evidence cannot satisfy the new epoch or approve its replacement packet. Ordinary independent approval is still required. Repeated submissions retain normal sequence gates and use distinct execution records rather than overwriting earlier validation.

A command amendment is not a test pass, failure waiver, phase approval or submission permission. Existing test-command identities, affected roots and source-extension coverage must remain; discovery and passing thresholds cannot decrease. Review the entire changed structured contract, including its report adapter, not just its displayed executable. Arbitrary policy migration and reopening completed work remain outside this route.

The recorded policy closure travels with the Story, but its private human-review origin does not. On another checkout, or after local proof is lost, `TCA_AUTHORITY_ORIGIN_UNAVAILABLE` stops ordinary accepted-policy use. Inspect `singularity-flow story test-policy attest <WORK-ID> --json`; the original recorded reviewer may then use its returned `--apply --confirm <REVIEW-SHA256>` action in a live terminal to re-attest that exact review. Another reviewer cannot impersonate the original reviewer. This recovery restores only checkout-local proof: it changes no tracked Story, source or policy bytes, reruns no test and does not qualify evidence from another host. If the original reviewer is unavailable, this pilot has no substitute-reviewer recovery route.

## State and safety

### Review actual native Node failures without changing their result

For a new Story, the approved `testRecovery` policy may additionally enable `new-test-failure`. It requires named `riskAuthorities`, `allowEvidenceReuse: true`, and an independent `caseInventory` for each selected code-delivery phase's single structured test command. Each entry declares `phaseId`, the exact `commandId`, `dependencyScope: repository-and-node-builtins-only`, and `tests` containing stable `id`, canonical repository-relative `path`, and exact native reporter `name`. The inventory is approved before execution; the observed report cannot invent the expected tests. Changing it changes the intake confirmation and pinned authority digest.

This adapter supports direct native `node --test --test-reporter=junit <explicit test files>` with a structured `junit-xml` result. It verifies the actual executable, completed process, streamed report bytes, one-to-one identities and source semantics. Flat cases only are supported; nested suites, duplicate/missing/extra cases, filters, arbitrary flags, wrappers and external-service tests remain ineligible. Skips require the separate reduced-coverage review below. Native reporter versions without file identities require exactly one independently declared test file. A failed process with an all-passing report remains an unexplained failure, not an eligible test-failure exception.

The approved dependency-scope declaration is a reviewer assertion, not proof of sandboxing. The adapter binds the effective child environment, bounded repository-local file bytes and directory paths/types/permissions, including ignored dependencies/data and empty directories; symlinked, hard-linked, oversized or uninspectable dependencies refuse qualification. Source, environment, installed dependency or report drift invalidates current use. Exact report-parent directories are prepared only when execution begins, not by a read-only preview. It does not attest network denial or qualify external service state. Do not select this scope for tests that depend on resources outside it.

Use changed-and-affected execution with independently proven coverage. A cohort equivalent to the entire approved inventory needs explicit full-suite expansion consent even when selected by file. All-configured execution and intake acceptance require the applicable exact baseline/coverage contracts; a summary-only readiness receipt cannot establish testcase identities.

### Python and Maven adapters

An inventory entry may select `adapter: pytest-junit-v1` or `adapter: maven-surefire-junit-v1`. Both require `dependencyScope: repository-and-declared-runtime-only`, `runtime.executableSha256`, explicit absolute `runtime.dependencyRoots`, and exact `className` alongside every test's ID, path and name. Runtime roots are approved per host, not guessed or copied across operating systems. Their executable, dependency bytes, path types and permissions are bound under traversal limits. These declarations do not attest sandboxing or network denial.

Python uses the direct approved interpreter with `-I -m pytest`, an exact JUnit output and explicit tests. Plugin autoload and ambient Python/pytest injection are removed. Maven uses the approved executable offline with explicit reviewed settings, approved local dependency cache and JAVA_HOME, ending in `clean test` so stale compiled classes cannot substitute for current source. Its bounded contract is parentless, single-module, default-target, without profiles or custom clean filesets; inherited/complex Maven builds are not qualified. Surefire reports are authenticated after process completion. Wrappers, arbitrary properties, undeclared caches and unsupported report layouts refuse qualification. Existing report files are preserved rather than accepted as the new run; Maven's explicitly reviewed clean action rebuilds only its qualified build output. A command that mutates product source cannot qualify its own evidence.

### Reduced coverage and supplemental documents

Enable `reduced-coverage` with independent inventory and `allowEvidenceReuse: true` to review actual skipped cases. Every expected identity must still be accounted for, with at least one executed case. Exit zero plus skipped tests means incomplete coverage—not a full pass. The exception names the excluded/skipped IDs and exact candidate; ordinary phase approval remains necessary. It does not enable arbitrary selectors, missing reports or fabricated empty suites.

Enable `nonessential-document` and declare `documentObligations`, for example `{ id: release-notes, phaseId: implementation, path: docs/release.md, requiredSections: [Usage] }`. Only explicitly pinned supplemental Markdown can use this route. Required artifacts, specifications, Story records, agent instructions and protected paths remain nonwaivable. Native inspection checks existence, bounded UTF-8 bytes and real headings outside code fences; unsafe filesystem entries refuse qualification.

Inspect with `story test-policy risks --work-id <ID> --phase <PHASE> --obligation release-notes --operation publish --json`. Pass the same `--obligation` when reviewing the returned exact issue. Each transition requires its own current decision. Missing/incomplete documents stay failed in the immutable review packet, with their observation and decision references; changing the document or candidate invalidates the old exception. Correcting the document clears its content finding but does not bypass normal generation freshness. Inspection writes only a bounded local diagnostic receipt; it neither edits the document nor accepts risk.

Use the same inspection, delegated terminal review, revocation and transition-specific commands below. The decision records exact failed IDs, semantics, cause, candidate, expiry, owner and remediation. The original observation keeps `observedOutcome: failed` and `executionOrigin: executed`; later consumers label its use `reused`, never a fresh passing run. Its raw report is retained in the review transaction. Passing WEL witnesses are not fabricated from accepted failures. Command amendments still require their own fresh validation.

### When the environment cannot run the tests

Sometimes a required test command cannot run on the machine doing the work: Maven or Gradle cannot reach the dependency repository, the JDK is missing, a proxy refuses the connection, Docker is not available for Testcontainers, or a database the tests connect to is not running. Publication and submission refuse the run with `CODE_TEST_FAILED`.

Every failed or blocked run is classified by what stopped it, read from its exit, the error its launch gave, its output and the failure message of each failed test:

| Cause | Class | Read from |
|---|---|---|
| Launcher missing or not executable | `launcher-unavailable` | spawn `ENOENT`/`EACCES`, `command not found` |
| Dependency not installed | `dependency-missing` | `npm ERR! missing`, `Cannot find module 'x'` from an unchanged file, `No module named`, Maven `Could not resolve dependencies` |
| Registry, network or proxy | `registry-unreachable` | `Could not transfer artifact`, `ENOTFOUND`, proxy and certificate errors |
| Toolchain version | `toolchain-version` | `UnsupportedClassVersionError`, `invalid target release`, engine requirements |
| Browser missing | `browser-missing` | Playwright `Executable doesn't exist … npx playwright install`, Cypress binary missing |
| No emulator, simulator or device | `device-unavailable` | Android `No connected devices!` / `DeviceException`, `adb: no devices/emulators found`, Xcode `Unable to find a destination matching`; SFlow never starts one |
| Service unreachable | `service-unreachable` | `ECONNREFUSED`, `Connection refused` |
| Docker | `docker-unavailable` | `Cannot connect to the Docker daemon`, `Could not find a valid Docker environment` |
| Permission | `permission-denied` | `EACCES: permission denied`, `PermissionError` |
| Every discovered test skipped | `all-tests-skipped` | the report |
| Compile error (code) | `compile-error` | `error TS…`, javac, kotlinc, rustc, `error CS…`, Go `[build failed]` |
| Syntax error (code) | `syntax-error` | `SyntaxError`, `IndentationError` |
| Import error (code) | `import-error` | a missing repository path, a package imported from a file the Story changed, a missing export |
| Tests ran and failed (code) | `assertion-failure` | a failed test whose message is not an environment cause |
| Timed out, or nothing recognised | `timeout`, `unrecognised` | neither is known to be the environment |

A code marker wins over an environment one. A run in which tests executed is an environment cause only when every failed test failed from one; a suite whose every test hit a refused database connection is `service-unreachable`. The class is recorded as `cause` on the run's attempt, and the refusal names it: an environment cause with the way out in `error.details.testRunRisk` (with `causeClass`), a code cause as never covered.

Fix the environment and run it again where you can. Where you cannot, a person who approves the step accepts that cause in their own terminal:

```text
singularity-flow decision test-risk <WORK-ID> --phase <PHASE> --command <COMMAND-ID> --cause-class <CLASS> --cause "<what in the environment stops it>" --reason "<why the risk is acceptable>" --expires YYYY-MM-DD
```

- **Who:** someone in an approval group of that step. A step nobody approves (quick-fix's implement) is answered for by the next step on the route that has approvers. An agent turn is refused; it shows the command and stops.
- **What it needs:** a recorded run of that command that failed or was blocked from an environment cause. `--cause-class` is taken from that run, and must match it when given; an approver whose checkout has no record of the run names the class and the `--argv-sha256` digest the refusal gave. The cause is 10 to 300 characters, the reason 20 to 1000, and the expiry at most 90 days ahead.
- **What it allows:** the tests still run at every publication and submission. Only a later run of the same command whose cause is the same class is let through. A compile, syntax or import error the change introduces, a failed assertion, a timeout or another environment cause is never covered, and a changed command needs a new decision. Decisions on different classes of one command stand side by side.
- **How long:** the step then carries through approval, later steps and Story completion while the decision is active. The evidence matrix shows its criteria as satisfied with an exception, never as passed. Once the decision expires or is revoked (`decision test-risk --revoke TRR-001 --reason TEXT`), the next gate refuses again; a new decision on the same command and class carries the runs an earlier one let through.
- **Decisions recorded before causes were classified** (no `causeClass`) stay valid until they expire, for runs in which no test executed and whose cause is the environment.

This needs no test-policy agreement at intake and works on any Story. The test-policy exception below is narrower and stricter: it covers only a missing executable, needs an agreement and named risk reviewers, and takes a decision for each transition.

### When a pinned test command changes

A test command Singularity Flow guessed for a module is pinned for the Story the first time a gate runs it: its argv, working directory, affected roots, result adapter, and the digests of what it resolves through, which are the package script chain (`pretest`, `test`, `posttest` and every `npm run`/`yarn`/`pnpm` script they reach), the module's runner configuration (`jest.config.*`, `vitest.config.*`, `playwright.config.*`, `.mocharc.*`, the package's `jest` key, `pytest.ini`, `[tool.pytest]`, `tox.ini`, `conftest.py`, the POM's surefire/failsafe plugins and `.mvn/maven.config`, Gradle `test` blocks) and any repository script the command runs. A configured or Story-only command records its definition the same way. The pin is written to `workflow.testCommandPins` when the gate commits; until then the step's first recorded run stands for it.

A later gate whose command differs (an edited `"test": "jest src/one"`, a new runner config, other argv) is refused with `TEST_COMMAND_PIN_CHANGED` before it runs, naming each change. Restore what was pinned, or request the new pin:

```text
singularity-flow decision test-command <WORK-ID> --phase <PHASE> --repin <COMMAND-ID> --reason "<why the test command changed>"
singularity-flow decision test-command <WORK-ID> --accept TCD-001        (a person who approves the step; or from /sf-decide)
```

The request records the exact new pin by digest and what changed. Anyone working on the Story may request it; only a person who approves the step accepts it (an agent is refused). The next gate run records it as the command's pin, naming the pin it replaces and the request. Each test attempt carries the pin it ran under, and the receipt replays only against a pin recorded on the Story. Line endings and the per-platform wrapper spelling (`./mvnw` or `.\mvnw.cmd`, `python3` or `py -3`) are not changes.

### When a run is narrowed

A gate run proves a module only when it ran the module's tests. Each gate run records on its attempt what narrowed it, and a run that passed narrowed is refused with `CODE_TEST_NARROWED`, naming each reason:

- **filter:** a test-selecting option in the command or in the pinned script behind it: `-Dtest`, `-Dit.test`, `-k`, `-m` (pytest), `--grep`/`-g`, `-t`/`--testNamePattern`, `--testPathPattern`, `--shard`, `--only`, `--tests` (Gradle), `-run` (Go), `--filter` (.NET), `--test-name-pattern` and `--test-only` (Node), and `--project` in a guessed command;
- **focused:** `.only`, `fit` or `fdescribe` in a changed test file the command covers;
- **skipped:** any skipped test (a test-policy agreement's accepted reduced coverage is judged by that agreement);
- **below-baseline:** fewer tests discovered than the first passing run of the same pin in this Story.

Remove the narrowing and run it again, or a person who approves the step accepts it with a reason, in their own terminal or from the decision list:

```text
singularity-flow decision test-narrowing <WORK-ID> --phase <PHASE> [--command <COMMAND-ID>] --reason "<why the narrowed run is enough for this step>" [--expires YYYY-MM-DD]
singularity-flow decision test-narrowing <WORK-ID> --revoke TNR-001 --reason "<why>"
```

It needs a recorded run of that command that passed narrowed. The decision is bound to the command's pin and to the narrowing it saw, and covers later runs of the same pin whose narrowing is the same or smaller: no new filter or focused test, no more skipped tests, no larger shortfall. Without `--expires` it lasts until the Story ends. An agent is refused; it shows the command and stops. The review (`Accepted narrowing: …`) and `tests summary` (`Narrowed: …; accepted as TNR-001: …`) show an accepted narrowing with its reason, and receipt replay checks the decision still covers the run.

### When no runner is found: a command for this Story only

Publication refuses with `CODE_DELIVERY_TEST_COMMAND_REQUIRED` when no test command is configured for the step and none can be inferred for its changed code. The same check runs as the code step opens, on the paths its plan names, so `phase enter` and `recover` say so before the code is written (`testExecution.planned.runner: missing`). Three routes, all person-decided:

- **This Story only:** the developer, or their agent, requests the exact command that runs the tests, and a person who approves the step accepts it.

```text
singularity-flow decision test-command <WORK-ID> --phase <PHASE> --use <SUGGESTION-ID> --reason "<why this command tests the step>"
singularity-flow decision test-command <WORK-ID> --phase <PHASE> --id <ID> --argv '<JSON ARRAY>' --working-directory <DIR> --affected-root <DIR> --adapter <ADAPTER> --report <PATH> --reason "<why>"
singularity-flow decision test-command <WORK-ID> --accept TCD-001        (a person who approves the step; or from /sf-decide)
singularity-flow decision test-command <WORK-ID> --revoke TCD-001 --reason "<why>"
```

  The request appears in the decision list of the people who may accept it. An accepted command runs at every publication and submission of the step like a configured one, covers its affected roots, and its tests must pass; nothing is waived. A step nobody approves is decided by the next step on the route that has approvers, under that step's self-approval rule. An agent may request, never accept or revoke. The repository configuration does not change.
- **Every later Story:** `/sf-test-setup` proposes the command (`capability test-setup --step <STEP> … --confirm`). Once a configuration approver activates it, `recover` offers this Story the adoption: a person who approves the step previews and applies `story test-policy amend --reason TEXT`, and the tests run fresh.
- **The repository's own runner:** repair an in-scope test script or runner declaration so a supported runner is inferred.

### Reusing a run an earlier step recorded

A step whose output is test evidence may record no run of its own: its retained packet says `no-governed-tests-in-this-packet`. Tests an author ran by hand in that step are not a recorded run, and nothing may report them as one. When an earlier step (usually Code) recorded a passing run and the source has not changed since, a person who approves the reusing step can decide that run stands for it:

```text
singularity-flow decision evidence-reuse <WORK-ID> --phase <PHASE> --from-attempt <TA-ID> --reason "<why the recorded run stands for this step>" [--expires YYYY-MM-DD]
```

- **Who:** someone in an approval group of the reusing step (as for `decision test-risk`). An agent turn is refused; it shows the command and stops.
- **Which run:** only a passed, structured attempt that an earlier, approved step's submission retained, read at that submission's commit and matching the digest it bound, with counts that meet the Story's minimums and no skipped test. A preflight attempt, a run kept only in one checkout, a failed run or a run a test-run risk let through cannot be named.
- **Source binding:** the decision binds the attempt ID, its record digest, its source commit and the application source tree digest it ran on (every path except the Story's own records; separately hashed test inputs included). It is refused with `EVIDENCE_REUSE_SOURCE_CHANGED` while any of that differs, naming the changed paths, with two ways forward: repair (return the change to the step that ran the tests) or a fresh recorded run. A decision recorded on an unchanged source lapses by itself as soon as the source or the attempt record changes, or the step that recorded the run is reopened; nothing is written when it does.
- **How it reads:** everywhere it is shown (the step's review, the retained execution evidence a later step and the conformance step receive) it reads `reused: <TA-ID> recorded by <step> at <commit>; approved for <PHASE> by <who> (ERU-NNN), not a run by <PHASE>`. A lapsed one says why it no longer applies. Revoke one with `decision evidence-reuse --revoke ERU-001 --reason TEXT`.

Evidence reuse and test-run risk answer different questions. Test-run risk accepts that tests could not run in an environment and is shown as an exception, never a pass. Evidence reuse cites a run that did pass, by the step that recorded it, for a later step that recorded none; it is never shown as that later step's run.

### Review an unavailable runner without declaring tests passed

New Stories may explicitly enable `validation-unavailable` and name `riskAuthorities` in approved `testRecovery` configuration. The named groups must already exist in `approvalAuthorities`; installing the runtime does not delegate anyone. Keep `allowEvidenceReuse: false` unless the independently inventoried failed-test adapter above is explicitly enabled. The current adapter requires one code-bearing repository and one explicitly named, structured test command per code-delivery phase. Unknown, inferred or multi-command risk contracts are refused during intake. Document-only workflows do not acquire test obligations.

This exception covers an authenticated native executable launch failure (`ENOENT`), not a process that ran and exited nonzero, a timeout, skipped tests, a missing report after execution, or a source-mutating command. The unavailable observation has zero executed tests and explicitly incomplete testcase inventory. It does not claim coverage. Source, exact command, selection, environment and host origin remain bound. Installing the executable, changing source or changing the environment invalidates the old observation and requires a new attempt. Historical test reports remain untouched and cannot substitute for the missing run.

Inspect `singularity-flow story test-policy risks --work-id <WORK-ID> --phase <PHASE> --operation publish --json`. The inspection runs no tests. If the immutable agreement lacks current authorization, preview `story test-policy attest-risk --work-id <WORK-ID> --json`; its returned apply action requires a live delegated risk reviewer. The agreement's original author is preserved and need not be the approving reviewer. A decision re-attestation, unlike an agreement authorization, requires its original recorded reviewer.

For an eligible issue, preview `story test-policy accept-risk --work-id <WORK-ID> --phase <PHASE> --operation publish --issue <ISSUE-ID> --reason "Substantive reason for proceeding" --follow-up-owner <OWNER> --remediation "Repair reference or action" --json`. Review the exact candidate, unavailable check, expiry and follow-up. Only its returned `--apply --confirm <PLAN-DIGEST>` command, executed by the delegated reviewer in a live terminal, can record consent. Expiry cannot exceed the pinned policy maximum. A checkbox, reason text or digest alone grants nothing.

Each transition is separate: `publish`, `submit`, `approve`, `downstream` and `replay`. Publication consent is not submission permission, normal phase approval, or permission to consume the result downstream. Review the corresponding operation only when the engine requests it; a published source phase can be named explicitly for downstream/replay review even after the active phase advances. The next gate reevaluates the same policy and exact record. A retained launch failure is not presented as fresh test execution, and it cannot satisfy a command amendment's requirement for fresh passing epoch validation.

The review transaction preserves application code and the original observation. Failed-publication rollback retains an authenticated checkout-local diagnostic so risk inspection does not dead-end; the accepted review commits its exact observation and selection with the decision. Required remote acknowledgement must complete before advancement. A pending push uses the existing recovery transaction, never a duplicate review.

To withdraw a decision, preview `story test-policy revoke-risk --work-id <WORK-ID> --record-sha256 <RECORD-DIGEST> --reason "Reason for withdrawing this exception" --json`, then follow the exact live review. Revocation is append-only and blocks future use; original evidence and past decisions remain intact. On another checkout, public JSON does not establish execution or human-review origin. Risk review can be restored by the appropriate reviewer, but an unavailable-runner observation must be captured on that host. Never copy private origin files to pretend qualification.

In VS Code use **Review Story Test Policy and Recovery → Inspect phase risks and reviewed exceptions**. Select the transition, inspect the JSON, then choose an eligible review or revocation. The final action only prefills a terminal; it does not press Enter or accept risk.

Inspect the engine's current test-policy, phase-risk or recovery result. Follow the exact returned legal action. A blocker should identify its stable issue ID, observation, disposition, preserved work, owner and repair/review route. Unavailable external prerequisites remain explicit; the agent must not invent a successful repair.

Risk review requires a substantive human reason, exact-plan confirmation, the applicable pinned authority and a durable decision receipt. An actor label, Git name, selected checkbox or exhausted repair budget is not proof of authority. Unsupported exception categories remain unavailable even if a client sends a flag. Known failures cannot be matched by counts alone; new failures, changed test meaning, missing identities or uncertain environments require a separate evaluation.

An accepted risk cannot waive identity, evidence provenance, protected-path authority or execution safety. An unavailable check stays unavailable; a skipped or excluded test is not passed. Evidence reuse must be explicitly qualified and displayed with its originating run. Moving the agreement to another host does not prove that tests ran there.

Selection consent is host-local and distinct from portable policy or evidence: a confirmation made in one checkout does not silently authorize a wider run on another host. Review the locally computed exact cohort and expansion again. The core evaluator and admission boundary remain authoritative; a UI state, copied receipt, selected default or agent-authored record cannot substitute for authenticated evidence, current authority or a commit.

The selection pilot can narrow understood direct Node test and Jest file commands. Pytest is currently module/suite-only: `PYTEST_ADDOPTS` and configuration `addopts` can add test roots beyond a file argument, and those collection inputs are not yet qualified for precise selection. Package scripts and other unsupported precise runners likewise require the disclosed module or full-suite expansion review. Explicit Node preload hooks also require expansion review. Inherited `NODE_OPTIONS` is not supported for any pilot test execution because it can preload extra tests; remove it from the invocation environment and review a fresh plan. Recognized legacy test commands must first declare a structured `kind: test` contract; they cannot run as an undisclosed extra quality gate.

When a later non-code review phase changes source, tests or build inputs, it cannot complete using the earlier Code generation's evidence. Follow the exact repair preview returned by the engine. Where the pinned rejection policy permits it, the confirmed return to Code preserves the edits and requires a fresh code generation and test execution. This is not permission to edit protected configuration or count a passing earlier run as validation of changed code. Ordinary documentation-only repairs do not themselves trigger this source-evidence check; other artifact and scope checks still apply. A review phase whose own policy confines its source writes to an explicit boundary (such as test automation) and that does not consume another phase's tests may keep edits inside that boundary in its own generations. Changes introduced by a later Code phase's own publications are not counted as review edits; edits made outside a publication still are.

Preserve owned drafts and published generations. Recovery now lists `applicationPaths` only after verifying the current open-generation baseline or exact prior publication and enforcing source/protected-path boundaries. Review that diff and authorship before following the returned prepublish or confirmed rollover command. A dirty README, test or source file is not automatically an unknown-worktree dead end. A supported post-publication repair creates a successor generation; a permitted policy-only amendment preserves content and advances its validation requirements. Missing scope proof, unrelated changes, removals, renames, conflicts and symlinks still need manual review. Recovery never commits, stashes, discards or executes these application edits. Unfinished required artifacts and failing tests still block publication until their actual obligations are resolved.

Never use blanket reset, clean, stash, deletion or a commit of unrelated paths as recovery. An unchanged failure stops automatic retries. Verified runtime repair can justify a bounded retry without a source edit. Budget exhaustion opens a human decision and never accepts risk automatically.

### Traceability annotation repair in the producer loop

`phase draft-check <PHASE> --json` and `phase prepublish <PHASE> --json` now return
`traceabilityRepair` for missing approved source tags, explanations and missing or unattached
acceptance tags. The shared projection names the verified planning pointer, exact planned paths,
current file hashes and scoped action/finding fingerprints. It writes nothing and runs no model
or test. Only an owned, current, open generation with a verified start receipt can offer routine
same-turn annotation repair. Pinned test-only/source-binding opt-outs remain respected.

`/sf-code` consumes those instructions in its existing bounded repair loop, including when routed
from VS Code's **Fix in Copilot**. It verifies the clause against the source hunk or test assertion,
checks target hashes again, and corrects annotations without a separate per-tag approval. A plan
file path alone does not identify a function or prove a test's meaning. Ambiguous mappings need
clarification; missing behavior or assertions need actual implementation. A test tag belongs
directly above an executable declaration, not at file scope. Tags never count as passing tests.

Tag-only corrections now move the source/test repair fingerprint even when the implementation
summary stays unchanged. Unrelated document edits cannot mask an unchanged tag finding. Recheck
and rerun configured affected tests; at most three distinct changed repairs are permitted.
Published/consumed generations retain their reviewed rollover route. Unsafe targets, unavailable
scope, protected paths and unknown clause identities receive no automatic annotation authority.
Approval, risk acceptance and publication/test gates remain separate. Shell checks show the same
repair instructions; they do not themselves apply a source patch.

A recorded commit awaiting push remains publication-pending. Resume that exact transport transaction; do not manufacture a second approval, decision or generation. A failed screen refresh after a committed change is a presentation warning, so re-read authoritative state.

## Troubleshooting

This implementation does not claim completion of all TRP v1.0 release acceptance criteria. The pure record/evaluation contract is broader than the operations each installed engine can authenticate and execute. Read the advertised capability and returned legal actions before using a route. Unsupported adapters, precise selectors, exception categories, amendment routes and baseline acquisition modes must fail closed or stay unavailable.

Actual failure review supports the explicitly declared native Node, pytest and Maven/Surefire contracts above. Jest/Vitest wrappers, arbitrary JUnit producers, general evidence reuse, missing/ambiguous inventories, multi-repository risk admission and blanket dirty-worktree/protected-state bypasses remain unavailable. The pure evaluator's broader contracts do not qualify a production adapter. A missing route is a stated limitation, not consent to edit workflow records by hand.

Passing local tests qualify the host on which they ran. Simulated Windows paths or platform flags do not establish native Windows qualification. macOS, Linux and Windows results must be reported independently; no cross-host execution evidence equivalence is implied by matching test names.

## Related topics

Continue with `singularity-flow explain recovery`, `singularity-flow explain story-lifecycle`, `singularity-flow explain approvals`, or `singularity-flow explain configuration`.
