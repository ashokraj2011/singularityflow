# Failure permissions, observed cohorts and external runners

This Phase 5/7 slice connects selected execution with actual environment or known assertion
failures, observed cohorts with retained execution, and explicitly pinned external test and
non-test commands. It extends the opt-in namespace SDK on `codex/engine-sdk-foundation`.
Production authority migration and host cutover remain separate.

## Responsibility boundaries

The kernel owns cohort comparisons, required failed-case sentinels and the separate permission
rules. SDK operations coordinate the existing registered vocabulary. SDA stores conditional
receipts and original reports. SGOS executes explicitly selected programs and retains their
actual results. The host chooses the executable, checkout, environment and report destinations,
authorizes execution and renders questions or command guidance.

No Git lookup, implicit working-directory discovery, model wording or executable lookup is added
to the kernel. External commands use the existing process owner, stop/quiescence protocol,
source observation and bounded report retention.

## Independent failure, scope and reuse permissions

A selected failed run keeps its real result, omitted cases and original check binding. An
environment-risk decision authorizes only its exact configured command and observed environment
cause. A known-failure decision still requires independently inventoried original failures,
unchanged protected inputs, matching failure semantics and the original human authority.
Neither authorizes omitting tests.

A separate selected-scope permission accounts for omitted passing baseline cases. Where an
observed cohort is also reviewed, its receipt remains a third independent decision. Publication,
submission, approval and downstream evidence check each applicable current permission. Renewal
does not replace the execution, change its timestamp or turn an exception into a passing result.

Known failed baseline cases remain executed. The new cohort comparison includes them in the
required baseline and rejects their omission with `TEST_COHORT_REQUIRED_FAILURE_SENTINEL`.
The original passing-only comparison remains unchanged when that explicit interpretation is
absent. Actual primary acceptance tests retain their independent witness checks; accepting an
unrelated legacy failure cannot waive a new acceptance failure.

Failed compiler, lint or other non-test commands retain their failures. An environment or known
test decision cannot waive them. Failed, skipped, cancelled or incomplete runs cannot become
passing reuse candidates.

## Cohort review and receiving reuse

`test-cohort.context` and `test-cohort.confirm` can name an explicit `observedPhaseId` and numeric
`candidateGeneration`. The context describes an actual retained execution and its receiver;
it does not claim another execution. Baselines, repository sets, commands and recovery agreements
remain pinned. A failed baseline needs its exact authenticated known-failure comparison.

New cohort contexts/records use v2. Their review transport distinguishes a recorded execution
from renewal of an original cohort. Later phases can renew that exact context using shared
records without source files, a private draft, an AST service or a process executor. Current human
authority, expiry and revocation still apply. Guidance and Decisions preserve the original producer
and receiving generation.

A cohort can accompany a complete, passing, independently authorized reused execution. Its v3
policy names the actual original checks and retained reuse policy, preserves omitted cases and
sets `testsReused: true` and `receiverExecuted: false`. An expired cohort cannot borrow a valid
reuse permission, and a valid cohort cannot supply missing reuse permission.

Independent whole-file selection and observed cohort review remain distinct. The selected case
inventory constrains actual reported identities; cohort approval cannot replace that inventory.
For native JUnit reports, a unique approved case declaration may supply its file location when
the reporter omits it. Missing or ambiguous identities still fail explicitly.

## Code, Verification and Release

Code v43 retains selected environment failures. Code v44 retains selected independently known
failures. Both preserve the underlying Code evidence version, actual test facts, omitted scope
and the separate human receipts. Their publication does not claim passing checks.

Recovery policy v6 links the actual failed execution and its failure-policy binding to the
selected scope. Its `riskKind` distinguishes environment and known test failures. All excluded
cases remain `not-run`, and `failuresWaived` remains false.

Approved Code-input v6 carries environmental failures, with optional selected scope. V7 carries
selected known failures. Verification receives original outcomes, checks, source inventories,
approval records and current permissions. It cannot invent a receiving test execution.

Release conformance v5/v6 discloses environmental execution exceptions separately from the
earlier known-failure meanings. A failed acceptance witness cannot support a `matched` row.
Its partial row and any required producer-owned human decision remain visible; adding a risk
record never fabricates a passing witness. The current-phase correction path can repair an
overstated report while preserving the approved Code generation.

## Pinned external execution

`testing/execution` exports `createExternalCheckExecutionUnit` and
`createExternalCommandExecutionUnit`. They accept explicit absolute executables and byte digests,
literal arguments, an exact environment, selected source root, timeout, content store and
authorization callback. They do not discover a runtime or change global installations.

Test commands select an existing structured-report codec, such as JUnit XML, Jest JSON or Vitest
JSON, and exact report files or stdout. SGOS verifies source snapshots before and after the run,
retains output and raw report bytes, and recomputes counts through the reader. Reports must be
fresh bounded regular files; stale output, symlink redirection, missing reports and corrupt
aggregate counts cannot establish a pass. Real errors retain their original diagnostics.

Non-test commands declare their command kind and retain process results with `tests: null`.
A successful syntax check cannot satisfy an executable-test obligation. Retained execution can
be reopened through shared records without the original checkout or interpreter.

These external profiles execute the complete approved command. They do not claim independently
inventoried framework selection, qualified toolchain equivalence or compatible cross-host reuse.
Such capabilities need their own explicit adapters and contracts. Existing full-command execution
remains available when a selective or qualified adapter is unavailable.

A structured result is execution evidence. Code acceptance still needs its independently bound
clause and witness identities; counts alone do not supply those identities. The Python qualification
uses an actual standard-library `unittest` run and an actual Python AST syntax check. It does not
certify every Python, JVM, browser or internal-framework runner.

## Shared fixes and compatibility

Genuine Code-input candidates are now registered for fresh-source checking in both ordinary
Verification and conformance paths. Forged or modified candidates still fail identity and digest
admission. Published risk-phase inspection no longer refers to a draft-local variable, and
published qualified reuse is recognized across its readable versions.

Fresh risk checks use the lifecycle's existing check reader, clock and execution bindings. Risk
interpretation does not construct a second incomplete freshness owner. Original human decisions
are fully replayed before retaining their consuming projections. Historical before/after state
trees are not duplicated in those projections. Invocation limits and mutation invalidation remain
unchanged; current authority and permission checks remain outside historical proof reuse.
The retained known-failure comparison also uses that existing bounded invocation domain, keyed
by its exact snapshot, original execution identities and interpretation time. Current permission
and actual source/environment checks remain separate. Copied results, failed reads, writes and
later invocations cannot borrow that comparison.

SGOS append derives its next head with the existing pure state codec from the completely verified
prefix and its newly constructed event. Restore uses the already verified backup head. Neither
path replays the same prefix a second time before its conditional commit. Ordinary reads and
explicit verification still read and validate the complete retained lineage; errors, corruption,
CAS conflicts and unknown-write reconciliation keep their existing behavior. Independent native
v1 packet hashes cover append, rollback and restore.

The filesystem SDA journal reads at most eight independent one-MiB entries concurrently, then
validates them in their original sequence. Its physical byte reads, digest chain, existing file
and memo ceilings and historical snapshot boundary remain unchanged. A later I/O failure cannot
replace an earlier integrity error or read failure. This removes serial filesystem wait without
using an advisory cache for lifecycle integrity.

Earlier record versions, hashes, native compatibility behavior and authority retain their
original meanings. New optional input fields do not add operation IDs. The original installed
package qualifier, its deadlines and all existing bundle ceilings remain unchanged.
Cohort version dispatch has one foundation profile owner; readers and rules consume its
capabilities. The original pure-value API's unversioned v1 context remains readable without
changing stored record or read-transport admission.

## Qualification

Mac qualification on Node 26.12.0 passes 969 distinct affected checks across 118 files, with no
failures, cancellations, skips or TODO tests in the final inventory. It includes 117 architecture
guards, 37 native SDK/CLI parity cases, nine additional offline installed consumers and the
unchanged 34-check original package qualifier. The final qualifier ran alone in 24.5 seconds under
its original 120-second parent and 60-second child deadlines.

Source validation passes 4,448 checks. VS Code typechecking, the unchanged 2,011-site Git audit
and all 13 original bundle ceilings pass; the gateway remains 852/852 modules and 6,947,836 bytes.
The operation vocabulary remains 97. No limit or qualification deadline was increased.

The inventory counts each file once. The regression launcher stopped at an outdated future-
version assertion after nine completed files; those nine passing files form the preserved prefix.
The corrected closed-version tests and all 100 remaining files then passed in the suffix run.
After source validation required centralized version dispatch, all 233 affected checks across
17 files passed again, followed by the unmodified original qualifier running alone. Repeated
files are deduplicated in the 969-check inventory. Windows, live providers, production installation
and main merge are outside this delivery.

Run the focused combinations serially on the checkout's Node runtime:

```sh
node --test --test-concurrency=1 test/namespace-selected-environment-risk.test.mjs test/namespace-selected-known-risk.test.mjs test/namespace-cohort-reuse.test.mjs test/namespace-risk-cohort-downstream.test.mjs test/namespace-external-runner.test.mjs
```

The offline packed consumer and declaration check are in
`test/engine-sdk-failure-runner-package.test.mjs`. The external execution qualification requires
an existing Python 3 interpreter; `SFLOW_TEST_PYTHON` selects its explicit discovery executable in
the test host. Product adapters receive the resulting absolute executable and digest. They do
not use that test-host discovery logic.

The two-repository combinations run as real headless SDK consumers under an outer test supervisor.
The consumer retains every journey assertion and fixture cleanup; it avoids a second test harness
tracking every internal promise. The 180-second parent and 170-second child bounds are unchanged.
This harness correction is separate from the product's removed duplicate journal replay and is
not reported as a product speed measurement.

The six complete two-repository headless cases passed on this Mac (Node 26.12.0):

| Original failure | Filesystem | SQLite | Application journal |
| --- | ---: | ---: | ---: |
| Independently known test | 133.0 s | 63.4 s | 64.3 s |
| Environment | 77.6 s | 47.5 s | 42.9 s |

These are synthetic qualification journeys with real stores and execution, separate human
identities, three permissions, expiry/renewal, receiving source checks and complete Release
approval/replay. They are not product Story-start latency measurements. The same plain-consumer
filesystem probe before read batching spent 120.6 s constructing its fixture and 18.7 s publishing
Code, then reached the 170-second deadline during approval. After batching, the measured setup
was 60.4 s and Code publication 5.9 s, with the complete journey finishing in 133.0 s. These are
individual local observations, not a cross-machine speed guarantee.

## Remaining owners

Additional framework-specific selectors and qualified external toolchains remain explicit
future adapters. The [completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md) continues to track live
application review, document/evidence exceptions, required external evidence and execution ports,
remaining native extraction and final complete-registry qualification. Neither Phase 5 nor Phase 7
is complete while those owners remain open.
