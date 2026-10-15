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
adapter as well as the original isolated reads. Shared state/configuration barrels still account for
394 static modules in this path after generator-metadata and host-diagnostic import isolation;
shared state/configuration barrels are an explicit remaining startup hotspot, not called solved.

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
