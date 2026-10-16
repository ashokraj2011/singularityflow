# Performance v2 implementation and qualification

This increment was developed from main `0e695809291c6196f8ce01656403f47e450269a0`, on
`codex/performance-v2`. It builds on the native Copilot efficiency work already on main; those
earlier savings are not counted again. Source changes are not an installed-build upgrade.

## Delivered changes

### One ordinary-draft session read

`session open WORK-ID --json` retains the original selection, local-open and remote-attach
operations. Only the following read-only projection changes: eligible session status, brief
context and canonical next actions consume one accepted Story execution and private read scope.
The service calls domain handlers directly; it does not capture stdout, change cwd or recursively
enter the CLI. The CLI remains responsible for rendering.

The projection uses the same registered model-free operation contexts and the existing accepted
catalog, session, context and next-action owners. It is not permission to edit, publish, submit,
review or approve. Those operations still perform their own fresh checks. A fresh post-mutation
scope cannot reuse a caller's mutable read observations or configuration overlay.

The snapshot observes exact workflow bytes, HEAD/ref identity, index, local configuration,
selection/session files, primary/supporting draft files, consumed briefs, grounding/prompt files
and relevant pending-publication markers. File content is hashed even if size and mtime match;
ctime additionally detects a change followed by restoring the original bytes. A relevant change
discards the response. There is at most one complete rebuild, then an actionable stale-read refusal.
The private dependency set is limited to 256 files and 32 MiB. It is discarded after the request.
A file removed or replaced by a link between stat and open also takes this bounded rebuild route;
it does not become a raw filesystem error or permission to consume the replacement.

The projection may reuse one observed HEAD for its exact root inside this private read scope.
Its owner independently observes Git before and after the scope; those observations never use
the reused value. An external commit invalidates the whole projection. Ordinary reads and all
mutations outside this scope retain their fresh HEAD behavior.

Current eligibility is deliberately narrower than every lifecycle state. Accepted snapshot-backed
open drafts with no published current generation and no required after-step deliveries use the
shared path. Workspace-only selection, legacy records, terminal/published/review/recovery states,
pending publication, remote-output records, live/unpinned agent checks, unsafe dependency shapes
and retention-limit cases keep the original isolated path.
A valid authority/integrity refusal is not converted into a successful fallback.

Diagnostic rollback is `SINGULARITY_FLOW_SESSION_READS=legacy`. This changes derived reads only;
it does not repeat a publication, erase a draft or change lifecycle state. No workflow YAML changes
are necessary, and eligibility does not depend on a phase's name.

### Async local Git and bounded reads

The central hardened Git executor now supports one closed asynchronous descriptor:
`repository.identity`. It requires an explicit absolute repository root and batches the repository-common directory, private Git directory, HEAD
and symbolic HEAD in one Git invocation. Callers cannot supply arbitrary Git argv through it.
Offline mode permits this exact local observation, not an arbitrary remote operation relabeled
as local. Executable resolution, enterprise configuration, output/deadline limits and process-tree
cleanup remain owned by the existing executor. Legitimate configuration-preflight processes are
included in measurements, not hidden.

The session service schedules these reads through a bounded kernel queue: four global slots,
at most two per repository, 64 queued requests, and interactive priority over background requests.
Each ticket restores its requester's operation, read and timing contexts, even when the shared
queue drains from another author's or reviewer's request. Queued cancellation removes work before spawn. A running slot remains occupied until its executor
settles cleanup. Filesystem snapshot work remains sequential, below the proposed eight-job limit.
Mutations and dependent test steps are not parallelized.

### Thin log command

Activity-log inspection has its own registered handler instead of entering the general CLI
dispatcher. Workspace aggregation and configured logging-level inspection load their domains only
when used. Existing formatting, filters, logging/redaction and harness behavior remain in place.

Local session opening also has an operation-specific adapter. The original selector resolution and
local transaction body were moved, not reimplemented: the compatibility dispatcher delegates to
the same function. Remote attachment and context-composition handlers are not in its static closure.
The local mutation still runs in a separate child, with the original fresh identity, workspace,
managed-worktree, agent and readiness checks. The rollback switch selects the original heavyweight
adapter as well as the original isolated reads. The first increment reached 394 static modules
in this path; the additional data-contract extraction described below reduces it to 379.
Shared state/configuration barrels remain a startup hotspot, not called solved.

`benchmarks/performance-v2/import-budgets.json` lists source-entry module ceilings and forbidden
heavy domains. Existing CLI source/bundle parity and VS Code bundle budgets remain separate gates.
No established ceiling was raised for this increment. An attempted broad dynamic AST import was
removed when it enlarged the gateway bundle; it is not represented as a shipped optimization.

### Workflow designer preflight

Before opening native chat, the designer calls the selected installation's
`workflow intent preflight --source approved|installed --json`. This registered never-model read
returns the compiler/parser protocol, content-bound engine identity, catalog digest and exact
configured checkpoint-group IDs. Source and bundled execution read the same packaged resources.

An incompatible engine stops before generation and preserves intent, selected assets and drafts.
It does not silently change catalogs or run an installer. The chat request names the exact
installation-approved executable and CLI script, rather than a different executable from PATH.

Checkpoint selection uses a picker of existing groups. Declining selection retains an incomplete
draft without a model request. A selected group is a human preference, not membership, consent or
approval. The compiler and activation gates continue resolving authority normally.

Native-tool registration is not treated as proof that a chat harness exposes that tool. The
verified CLI/file fallback and attachment read groups are provided even when registration succeeds.
Missing/stale retrieval guidance, malformed capture identity or withheld attachments stop the
handoff with a recapture/removal route. Attached content remains untrusted conversion material.

Catalog searches retain debouncing and request/revision checks, and now cancel supervised CLI work
on supersession, panel disposal or an explicit cancel message. Intent catalog/preflight and markup
preview reads are classified as reads by the VS Code client; compilation with an output file
remains a mutation. Classification parity tests cover the registered argv.

## Existing foundations retained, not new savings

Phase entry already constructs accepted execution once and retains its exact captured catalog.
Catalog and source-analysis caches already use content/interpretation identities with bounded
request scopes. Delivery replay already batches immutable objects and falls back per unsupported
entry. Publication already keeps security admission, fresh test execution, exact evidence replay,
transaction recovery, commit and push boundaries. Native skills already have single-entry,
action-first and bounded-output contracts. The implementation reuses these owners rather than
introducing alternative lifecycle rules or a second telemetry stack.

## Qualification and remaining release work

The final 30-pair Mac arm64 / Node 25.5.0 / Git 2.54.0 source cohorts produced:

| Component | Reference p50 / p95 | Candidate p50 / p95 | Result |
| --- | --- | --- | --- |
| Existing managed local session open | 2,971 / 3,510 ms | 1,999 / 2,576 ms | 32.7% lower p50 and 26.6% lower p95; proposed 30% / 20% component target met in this cohort |
| Activity-log startup, empty log | 480 / 526 ms | 279 / 300 ms | 41.8% lower p50; proposed 25% startup target met in this cohort |

Compared session/context/next-action fields remained exactly equal, with 11,968 emitted bytes
in both routes and verified local-only managed-checkout selection. Separate instrumented calls
observed 79 Git launches on main and 56 on the candidate, including Node descendants: parent
49 → 26, descendants 30 → 30. Both kept the one isolated local-opening mutation child. This
probe observes Node child-process launches, not an OS-wide trace; its extra instrumentation is
not included in latency samples. End-to-end latency still waits for the child.

Each eligible combined read projection constructed accepted state once. The log command loaded
274 runtime modules rather than 695. Session coefficients of variation were 7.3% for main and
11.2% for the candidate, with all outliers retained. A component point target is not a repeatability
or general-release guarantee. Neither result is a complete Story, Windows or billing saving.

Raw observations, earlier development probes, provenance and explicit qualification gaps are in
[`mac-source-report.json`](../benchmarks/performance-v2/mac-source-report.json). Earlier absolute
timings differ substantially between cohorts; their absolute change must not be attributed solely
to the local-adapter split. The paired within-cohort comparison is the reported component result.
These fixtures and reports are development-repository assets, not installed CLI lifecycle evidence.
The first two diagnostic session cohorts accidentally exercised fallback attachment rather than
an existing managed checkout; their original observations remain with explicit corrections in
the report. Earlier corrected managed cohorts improved median latency by 31.4% and 29.9%; the
latter narrowly missed the target and is not rounded into a pass. The final source cohort is
identified separately. Component results are not a universal fixed-speedup guarantee.

The local test/measurement commands below invoke no model. Fixtures create disposable local
repositories and local bare remotes, not user Stories or remote GitHub publications. Final source
reference/candidate pairs compare the exact cloned main revision with frozen candidate sources,
alternate order, run five warmups and retain all 30 observations. The baseline's lockfile matches
the candidate and both use the same Node/Git/dependency runtime. These are historical source
comparisons, not installed-binary or native Copilot Story measurements. Leave the baseline CLI
unset for a same-binary diagnostic rollback comparison, not a historical main result.

```sh
export SINGULARITY_FLOW_BENCHMARK_BASE_CLI=/absolute/main-baseline/bin/singularity-flow.mjs
export SINGULARITY_FLOW_BENCHMARK_BASE_COMMIT=0e695809291c6196f8ce01656403f47e450269a0
SINGULARITY_FLOW_SESSION_BENCHMARK=30 node --test test/session-open.test.mjs
SINGULARITY_FLOW_LOGS_BENCHMARK=30 node --test test/logs-entry-performance.test.mjs
node --test test/lazy-startup-reads.test.mjs test/cli-bundle.test.mjs
node --test test/stable-read.test.mjs test/session-read-service.test.mjs test/verified-read-head.test.mjs test/read-scheduler.test.mjs test/local-async-read.test.mjs
npm run vscode:typecheck
npm run vscode:build
npm run vscode:bundle-budget
npm run check
node scripts/git-bypass-audit.mjs
npm run audit:model-boundary
```

The benchmark diagnostic includes raw observations, p50/p95 summaries, runtime, package mode,
process/import counts where measured and result parity. Both routes request the CLI's existing
Node compile cache when supported. Fresh processes with warm OS/compile caches are not called
cold storage or cold module compilation. Unavailable peak-resource and native-host metrics are not reported as zero.
The existing DX 500-file/10,000-file protocol and accepted budgets remain unchanged.

| Milestone | Engineering coverage | Qualification boundary |
| --- | --- | --- |
| M0 | Import manifest, shared-read counters, paired session/log fixtures, existing DX telemetry | Frozen local pairs are component cohorts; full scale and installed-host cohorts remain required |
| M1 | Typed shared session reads, private content-stamped snapshot, bounded rebuild, fresh operation scopes | Exceptional states deliberately retain reference reads; phase-entry latency target is not newly certified |
| M2 | Thin log/local-opening adapters, forbidden-domain/module ceilings, runtime import comparison, source/bundle preflight parity | Shared state/configuration barrels remain heavy; not every operation handler has been isolated |
| M3 | Closed local async descriptor, bounded scheduler/cancellation, existing central process cleanup | Native Windows timing and process-cleanup qualification remain outstanding |
| M4 | Existing immutable replay/parser/publication reuse retained and regression-tested | No new intake/publication percentage is claimed without separate frozen cohorts |
| M5 | Engine/group/attachment preflight, exact fallback location, cancellation and read classification | Actual chat-harness exposure is unknown until used; complete native Stories remain unmeasured |
| M6 | No new worker activated | Expansion is disabled: no installed-host resource/latency evidence satisfies the proposed go/no-go gates |
| M7 | Local safety, type, source/bundle and unchanged bundle-budget checks | Not a general-release certificate; matched native Story and installed platform qualification remain required |

General-release qualification still requires unchanged-policy installed macOS and Windows cohorts,
controlled-network timing, three explicitly authorized matched native Copilot Story pairs, scale and
adjacent-journey regression evidence, and the proposed intake/publication/phase-entry target checks.
No native Windows result, provider usage, billed-token saving, Story p95 or full-Story speedup is
inferred from this Mac source run. A failed/noisy cohort remains visible rather than relaxing a
budget to accept it.

### Unfinished performance work

The final local session and log cohorts meet their component targets. Phase-entry, intake and
publication targets and broader release qualification are still open, not waived. The local-opening
closure still contains 394 static modules. Two import isolations are already delivered:

- The closed generator-name predicate now lives with pure phase metadata, so configuration no
  longer imports source/Jira rendering to validate a name. Tests bind that inventory to renderers.
- The shared state owner now loads the SKP host diagnostic only for an actual skill-phase boundary.
  All five callers await the same unchanged refusal, before generation, preparation, publication,
  submission or approval. Ordinary local-opening imports no longer reach the model runner.

Further shared-barrel isolation and child-stage/journey measurements remain follow-on work; the
two specific eager-import removals above are implemented and regression-tested. Measure child
startup and critical paths before choosing further session, phase-entry, receipt-backed intake
or publication changes. Keep mutation process isolation and fresh checks; do not claim a worker,
a different approval policy or skipped test execution as a speed fix.

The final focused runs passed 17 snapshot/queue/local-read tests and 55 designer/import/bundle/
model-boundary/lifecycle tests. The isolated Git executor suite passed 69 tests. An earlier
concurrent build/test run retained one failed 10 ms deadline assertion: the deadline expired
before mock spawn. Its isolated rerun passed; no timeout or assertion was relaxed. Broader
publication, evidence, intake and worktree regressions are listed separately in the report;
overlapping run counts are not added together as unique tests.
The repository check passed 2,576 checks; VS Code typecheck/build, the unchanged bundle ceilings,
the model-boundary audit and the registered Git-process audit also passed.

### Acceptance trace groups

- AC-001–005: session projection parity/counters, stable-read content/ABA/missing-path/concurrency
  tests, external-commit invalidation, phase-neutral eligibility and isolated remote-output fallback,
  and existing read-scope/catalog isolation tests. Mutation freshness remains in the owners.
- AC-006, AC-019: import manifest, lazy-startup, custom-phase entry and existing neutral-hook tests.
- AC-007–008: closed-descriptor/scheduler and existing hardened Git execution/process-tree tests;
  native OS qualification is separate from simulated Windows branches.
- AC-009–011: existing delivery, source-analysis, publication, linked-worktree, stale-evidence and
  intake-receipt suites. Tests, admission and consent are not cached by the new session service.
- AC-012–016: preflight/frontend tests for exact protocol/catalog, unresolved group, missing native
  tool with CLI fallback, stale/withheld attachments and supervised cancellation.
- AC-017, AC-020, AC-023: existing compact packet, never-model operation, model-free command,
  timing/redaction and exact independent-review boundaries, plus new closed counters.
- AC-018, AC-024: bounded snapshot fallback and existing worker protections; expanded workers stay off.
- AC-021–022: only local source component cohorts are available here; complete scale, native Story
  and installed-platform acceptance is not marked passed.

## Additional Mac observations (16 October)

See [`mac-additional-report.json`](../benchmarks/performance-v2/mac-additional-report.json) for
the complete additional cohorts, including failures. These measurements used reference main
`ee4ba18b3d256380041e2d62484ca98e3361eb66`. Main changed again after measurement; the older
cohort is not relabeled as qualification of that later integration.

### Retained engineering changes

- Sequence refusals attach their structured result through the existing data contract instead of
  importing rendering and continuation machinery. The local-opening static closure falls from
  394 to 379 modules. The import ceiling is tightened, not increased. The output-boundary exports
  remain compatible, including the original non-enumerable error property.
- Recovery asks Git for its five merge/rebase bookkeeping paths in one invocation. It still checks
  marker presence fresh and retains individual Git lookups for unsupported/ambiguous output. Git
  still resolves linked-worktree and environment override semantics. Normal and linked-worktree
  drift guards are regression-tested; no index, HEAD, approval or publication evidence is cached.
- Phase entry exposes separate binding, authoring, recovery, reference, execution-evidence,
  upstream and clarification spans. These are diagnostics, not additional gate checks.
- VS Code explicit refresh overlaps the independent local lifecycle read with remote Inbox
  discovery, only after validating the selected repository and current window epoch. Each owner
  keeps its cancellation/freshness checks. A rejection is handled immediately and joined before
  success; stale results never become authority, and no test or mutation is parallelized.
- The real-host fixture now initializes its canonical empty state index before timing. Earlier
  fast failed discovery calls remain recorded as incomplete, not accepted as a speed improvement.
- Source-only native qualification and paired phase/publication fixtures were added. Native
  launch is explicit, restricted to the fixture and uses the provider's soft credit cap, not a
  guaranteed spending ceiling. It never approves or installs.
  DX reports can be saved with `--out=PATH` without changing the fixture or accepted baseline.
- Two tests now decode file URLs correctly in paths containing spaces; their original failure
  and successful reruns were retained. No production permission was relaxed to fix a test.

An attempted first-use split of several state mutation dependencies passed functional tests but
grew the bundled gateway to 7,650,974 bytes. It was removed. The retained gateway is 7,464,431
bytes / 681 modules, within the unchanged 7,470,000-byte / 691-module limits. Refactoring the
larger state read gateway remains necessary; adding dynamic imports indiscriminately is not a fix.

### Native CLI: three pairs reached Intake, not complete Stories

The user authorized the quota-consuming runs, then explicitly requested: **stop at Intake and
report partial results**. All six final runs published Intake generation 1 with
`governed-agent/copilot-host` authorship. No benchmark Story was submitted, approved, implemented
or closed. Existing human checkpoints were not bypassed. No further provider turn is authorized
by this qualification runner after that stop instruction.

The same quick-fix definition, model (`gpt-6.1-sol`), CLI host and tool allowlist were used with
alternating pair order. The two-file fixture changes a numeric export from 1 to 2 and its existing
test. This is intentionally a small fixture, not evidence for all workflows or large repositories.

| Observed Intake measure | Before | After |
| --- | ---: | ---: |
| Median CLI session wall time, 3 runs each | 89.4 s | 77.6 s |
| Total tool calls, 3 runs each | 51 | 43 |
| Total provider-reported AI credits | 44.11228 | 37.59477 |

Two exploratory provider turns used a further 20.03613 credits and are excluded from the table:
one lacked GPT's `apply_patch` tool, and one inherited the deterministic fixture's no-model setting,
which mislabeled publication as manual authorship. Fresh final fixtures corrected both. Earlier
argument/model rejections made no provider call. Total observed native use, including exploration,
was 101.74318 AI credits. Raw prompts, sessions and logs remain private, not committed here.

The approximately 13% lower observed median is **not a proven saving**: three pairs, different
authored prose, provider caching and model variability do not establish causation, Story p95,
universal token savings or billed savings. SFlow's kernel correctly reported no kernel-owned model
invocation; the native provider's separate export supplies the usage above. These are CLI-guided
authoring runs, not VS Code Copilot plugin or complete-Story qualification.

### Remaining failures are not waived

The 30-pair / five-warmup source cohort observed phase-entry medians of 502.2 to 480.9 ms (about
4.2%), below the proposed 25% improvement. Publication total medians were 1,000.4 to 983.7 ms;
its p95 increased from 1,445.4 to 1,701.2 ms. That noisy tail is retained. Total publication includes
local commit and transport; an orchestration-only improvement is not certified.

The real VS Code development-extension probe observed changed-refresh median latency decrease
from 1,299.6 to 830.6 ms, with p95 from 1,396.1 to 959.1 ms after overlapping the independent reads.
It meets that component's 1,000 ms tail budget in this run. However, the enforced three-pair report
still fails its 30-pair minimum and activation, cached-paint, confirmed-paint and unchanged-refresh
tail budgets. It is not an overall host qualification pass. Other workloads on this shared Mac
and concurrent probes can affect the tails; no slow observation was removed.

The unchanged 500-file / 10,000-file DX protocol ran. Large-repository subprocess counts stayed
constant, but several reference-fixture latency budgets failed; its pinned Linux baseline is not
comparable to this Mac. The report retains those failures and the dirty-tree, ignored-tree,
submodule and linked-worktree observations. The expanded worker remains disabled.

Still outstanding: receipt-backed intake/start percentage qualification, the larger state-read
split, full native Stories, installed macOS and Windows qualification, and all required targets
and adjacent-tail budgets. This branch is engineering progress, **not completion of every milestone
or a general-release performance certificate**.

### Post-measurement integration

Main `624a46d50a228d757182dfc752f286d84558921a` was merged cleanly into this branch after
measurement. The recorded cohorts above retain their original reference and candidate observations;
they do not qualify the newly integrated source. Repository checks passed (2,582), VS Code build
and type-check passed, and unchanged bundle ceilings passed: gateway 7,464,533 bytes / 681 modules.
Post-merge focused regressions passed 148/148; startup, host-fixture and attachment tests passed
23/23. These functional checks do not turn the failed performance budgets into passes.
The native runner's persisted user stop is regression-tested with no provider available on PATH.
No additional native turn, human approval, installed-build change or release qualification followed
the stop instruction.
