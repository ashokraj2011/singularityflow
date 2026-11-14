# Source-bound impact selection and combined evidence reuse

This Phase 5/7 slice on `codex/engine-sdk-foundation` adds source-bound impact selection,
an explicit pinned-script selector, and a separately admitted combination of selected execution
and qualified reuse. These are opt-in namespace SDK profiles. They do not switch the installed
Git engine or Copilot skills to a different authority. The remaining owners are tracked in the
[completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md); neither phase is complete.

## Ownership

The kernel owns graph admission, transitive impact closure, conservative expansion, independent
test inventories and human permission rules. SGOS reads actual captured source bytes and invokes
a host-supplied language/AST analyzer. SDK operations coordinate exact manifests and conditional
acceptance. SDA retains original observations and receipts. A host renders the questions and
commands; no model wording, Git discovery or repository execution enters the kernel.

`testing/execution` exports `createSourceTestImpactUnit`. Its inputs are explicit source units,
matching source-content readers, and an analyzer with an ID, version and implementation digest.
The analyzer receives actual file bytes after their size and hashes have been verified. The
source revision is checked again after analysis. Its returned graph contains only repository/path
identities, hashes, dependency edges and bounded unresolved-input reason codes. Source bodies,
additional graph fields, accessors, foreign members and substituted revisions are refused.

The host can adapt its existing AST service for JavaScript, Java or another framework without
introducing a framework dependency into the SDK. This delivery supplies the port and closure,
not an all-language semantic analyzer. The bound source set has a 64 MiB input limit. The analyzer
has an explicit asynchronous deadline and abort signal; this is not a separate-process CPU limit.
Real missing-file, permission and timeout errors keep their original identity and details.

## Reviewed impact selection

The existing `test-recovery.select-context` and `test-recovery.select-confirm` operations accept
`mode: 'changed-and-affected'` as an alternative to an explicit manual `selection`. No operation
ID was added. The host binds `checks.impact`; a caller cannot supply graph results or success flags
as lifecycle inputs.

```js
const input = {
  phaseId: 'implementation',
  baselineOperationId: 'original-full-checks',
  mode: 'changed-and-affected',
};
const review = await engine.run('test-recovery.select-context', input);
```

The baseline must be the actual full configured execution of the original Story source, with
the same approved commands, configuration, repositories and recovery agreement. Its independently
inventoried cases must have passed. A later full run cannot impersonate the original baseline.
The receiving selection is computed from exact changed bytes, reverse transitive dependencies
and explicitly planned tests, including dependencies across repositories. Graph cycles terminate.

Unresolved inputs, incomplete graphs, removed/unmapped sources and protected test, runner,
configuration or dependency changes expand the configured file inventory. An empty affected set
also expands the command. Planned and changed tests cannot be excluded. No graph produces a
successful zero-run, proves semantic completeness, waives a failure or grants human permission.
Knowledge that exceeds the existing 2 MiB review-packet limit returns the complete configured
check action. It does not record a scope exception or leave only an unusable oversized review.

The authorized human reviews the exact context digest and supplies a reason, bounded expiry,
follow-up owner and remediation reference to `test-recovery.select-confirm`. Existing authority,
expiry and revocation rules still apply. Actual execution independently checks the selected report
against the approved case inventory, preserving all omitted IDs as `not-run`.

An impact request may name `candidateGeneration` for the current or next generation. This names
the intended successor; actual execution must still bind the real prepared draft. Original
selection and publication evidence remain immutable. Decisions and downstream recovery actions
preserve the original mode, baseline and candidate generation rather than guessing a manual
selector. Original-owner renewal can use retained source observations after the workflow advances,
including from a device without source files, a private draft, an AST service or an executor.

## Pinned repository scripts

Alongside the original direct Node JUnit selector, an approved independent inventory may declare
`adapter: 'node-script-junit-v1'`. Its supported command is deliberately explicit:

```text
node test-runner.mjs --test-reporter=junit -- test/first.test.js test/second.test.js
```

The script itself, stdout reporter routing, independent case names/paths and dependencies are
bound to the original source. SGOS replaces only the literal file list after `--`. Arbitrary flags,
globs, case filters, environment injection and another runner are refused. The actual raw JUnit
report must independently match every selected case. This does not certify arbitrary npm, Maven,
Gradle, pytest, browser or external-service selectors; unsupported runners retain their full-command
execution or explicit command-amendment route.

## Selected execution and qualified reuse

Reusing selected execution requires three separate admissions:

- The host binds `checks.combinedEvidenceReuse: true` and real qualified execution/environment ports.
- The approved workflow enables recovery and evidence reuse, includes the required risk authority
  and independent case inventories, and names `reuseProfile: 'environment-qualified-selected/v1'`.
- An authorized human records the recovery agreement with
  `reuse: 'environment-qualified-selected'`, then separately authorizes the actual selected scope
  and each original command's reuse.

Original no-reuse agreements remain no-reuse. The earlier exact full-execution agreement cannot
authorize selected-run reuse. An active reuse permission cannot replace an expired or revoked
scope permission; neither permission is phase approval.

The original selected execution must really pass, with no missing, failed, skipped, cancelled or
todo cases. Reuse authenticates its source inventory, configured commands, actual selected argv,
runtime digest, environment, platform, architecture, host and raw result. A receiving full selector
is compared with the original full-command identity while the selected execution keeps its actual
narrowed argv. Changed source, dependencies, environment or overly old evidence requires fresh
execution. Renewal cannot reset an execution's original completion time.

After an execution is authenticated, a receiving lifecycle action can use its retained graph
without rebinding the original AST service. It still compares actual current source bytes,
observes the qualified environment and checks current scope permission. Changed sources are
refused before graph consumption. Creating a new impact review or executing a newly selected
generation still requires the bound analyzer.

The same combined profile supports a complete passing set of tests and qualified non-test commands,
such as a real `node --check` compile observation. A compile result has `tests: null` and cannot
satisfy a test obligation. `createEnvironmentQualifiedNodeCommandExecutionUnit` provides that
separate SGOS observation without inventing a test report.

Full mixed-command reuse still needs the combined host capability, actual qualified observations
and the individual human reuse decisions. When recovery is enabled, its compatible agreement is
also required. A workflow with recovery disabled does not acquire an invented recovery agreement.

Code publication records `checks: null` when it consumes reused execution. The original run,
selection and human permissions remain linked independently. Verification and Release receive
both the original test facts and the still-unexecuted scope. Completion stays
`complete-with-exceptions` where appropriate; reuse never claims a receiving test run. Permission
renewals and replay work from shared storage alone, without recreating an earlier phase or Story.

Combining selected scope with an actual failed-environment risk remains an explicit unfinished
owner. Its refusal offers revoking the selection, rebasing/retaining the current source and running
the complete configured checks in the same phase. It does not relabel a failure as success.

## Version and compatibility boundaries

| Meaning | New contract |
| --- | --- |
| Source-bound graph | `sflow-test-impact-observation/v1` |
| Impact/script selection context and human record | Selective recovery v2 |
| Generalized selected check plan / summary | Check plan v6 / selection summary v2 |
| Selected-scope recovery agreement | Recovery agreement/context v3 |
| Combined selected/mixed-command reuse | Evidence reuse v4 |
| Generalized selected Code execution | Code v40 |
| Reused selected Code execution | Code v41 |
| Reused complete mixed-command Code execution | Code v42 |
| Generalized selection / reused selected recovery report | Recovery policy v4 / v5 |
| Downstream selected and reused Code evidence | Approved Code inputs v5 |
| SGOS selected script / qualified non-test command | Local check execution v4 / local command execution v2 |

Earlier schema versions, native hashes and authority retain their original meanings. Code-input
and conformance dispatch derive their readable ranges from the central schema families; adding
an admitted version cannot silently omit it from a second hardcoded whitelist. Unsupported future
versions still fail explicitly.
The new selected-reuse agreement marker applies only to the new agreement/context family versions;
recovery report and manifest v1 through v3 keep their exact original profile projections.

Completed original proof reuse is invocation-local and limited to the existing 256 entries and
8 MiB. Accepted human-decision projections retain only their consuming values and original source
bindings after full receipt replay. Original state and transaction histories are not duplicated in
each cached projection. Mutation boundaries invalidate the cache; live source/environment admission,
current permission, expiry and final authority checks remain separate and fresh. No new persistent
cache or larger cache/bundle allowance was introduced.

The retained-lifecycle reader's existing deep-frozen result can be shared within that invocation
without copying entire before/after state trees for every nested read. Its dedicated memo freezes
the verified result and keeps the same bounds and invalidation rules. Ordinary mutable projections
continue to receive detached copies; no caller can use an immutable-result flag to change admission.

## Qualification method

Final affected qualification on macOS arm64 with Node 26.12.0 passes 850 distinct tests across
104 files, with no failures, cancellations, skips or todo cases. This includes 117 architecture
guards, 37 native SDK/CLI parity cases, eight additional installed consumers and the unchanged
34-check package qualifier. Source validation passes 4,437 checks. VS Code typechecking, the
unchanged 2,011-site Git boundary audit and all 13 original bundle ceilings pass. Gateway remains
852/852 modules and 6,947,370 bytes. No Windows, live provider, production installation or main
merge ran; the registry still contains 97 operations.

The two-repository journey executes actual source changes, selected tests, Code publication and
independent approval, receiving reuse, Verification, Release and original-owner renewal from an
empty device on filesystem, SQLite and application storage. Another installed offline consumer
creates impact-selected evidence, rejects a changed source before submission, then completes
publication, submission and approval without Git, the CLI or the original AST service. Its NodeNext
contract checks accept numeric successor generations and reject string generations.
The final two-repository journeys take 113.9 seconds on filesystem storage, 51.5 seconds on SQLite
and 52.4 seconds on application storage. These are observed qualification durations, not a
before/after performance claim.

Early nested test-worker runs of the new two-repository journey exceeded its 180-second bound.
Repeated receipt copies were removed as described above. The final harness supervises the same
journey and assertions in a real embedding process per storage backend, with the original
180-second parent bound and a stricter 170-second child bound. This does not establish a general
cause for all timing variation. No assertion, skipped test or timeout is counted as a pass.
The existing installed-package qualifier remains unchanged and runs alone under its original
120-second parent and 60-second child deadlines; its final run completes in 52.1 seconds.

## Remaining work

Additional external runner adapters, selected execution combined with failed-risk/cohort profiles,
live application review and the other Phase 5/7 owners still need explicit contracts and journeys.
The production authority migration and final cutover remain separate phases. This slice does not
claim those capabilities through flags or silent fallback.
