# Independent selective recovery and qualified reuse

This opt-in SDK slice adds independently inventoried whole-file execution and current-environment
checks for artifact-phase reuse. It does not change installed Git/CLI ceremonies, replace human
approval, or complete the remaining Phase 5/7 owners listed in
[the active ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md).

## Ownership

- Kernel: validate file selections, preserve required tests, disclose exclusions, bound human
  decisions and compare environment identities. It has no repository, process, provider or clock discovery.
- SDK coordination: read the original accepted source, approved command/case inventory, real SGOS
  baseline and human authority through explicit ports. Both new operations enter the existing registry.
- SDA: retain immutable source/check/decision evidence and conditionally accept the existing
  namespace journal transactions. Namespace keys and the existing authority epoch stay unchanged.
- SGOS: execute the actual pinned Node binary, select complete files from its original command,
  observe the real checkout and retain raw reports, output, exit status and timeouts.
- Host: supply source/execution/access/clock ports and render the returned actions. The SDK does not
  generate a Copilot prompt, discover a CLI or grant a reviewer identity.

## Selective execution

The new operations are `test-recovery.select-context` and `test-recovery.select-confirm`.
`phase.checks.run` remains the one check coordinator. Its new plan version binds an authenticated
selection amendment to the original full-command recovery agreement.

The approved workflow must enable `testRecovery`, `allowEvidenceReuse` and `reduced-coverage`,
and declare an independent `caseInventory`. This first execution profile accepts direct
`node --test --test-reporter=junit <explicit-files>` commands with
`node-test-junit-v1` and `repository-and-node-builtins-only`. Each case has a unique independently
configured file/name/ID. Name patterns, globs, extra runner controls and arbitrary request argv are
not selectors.

Before feature edits, run the full configured checks on the original Story source and retain that
actual result. An unrelated command may fail there, but every independently inventoried command
being narrowed must have executed all its expected cases successfully. A later feature run cannot
be relabelled as this baseline. Source binding, original configuration, acknowledged commands,
repository selection and full recovery receipt must all agree.

Read the candidate selection with explicit repository and command identities:

```js
const selection = [{
  repositoryId: 'app', commandId: 'legacy-tests', files: ['test/first.test.js']
}];
const context = await engine.run('test-recovery.select-context', {
  phaseId: 'build', baselineOperationId: 'original-full-run', selection
});
```

The returned manifest contains selected and excluded independent case IDs, original baseline,
source observations, qualified environment, required authority, maximum risk duration and the exact
confirmation action. `impactComplete: false` is intentional: a reviewed file selection does not
claim dependency-complete automated impact analysis.

A genuine authorized person confirms the returned digest, reason, expiry, follow-up owner and
remediation reference through `test-recovery.select-confirm`. That is a human scope decision,
not a test result or phase approval. The bounded history is append-only, and an identical operation
ID replays its original acceptance after an interrupted acknowledgement. An active selection
cannot silently be replaced by another scope.

The host supplies `createEnvironmentQualifiedNodeCheckExecutionUnit` from `testing/execution`.
Its `selectTestFiles` capability accepts only whole files from that pinned native command. The SDK
checks its actual selected manifest against the reviewed file list. Unselected commands still run
in full. Planned acceptance files and changed test files cannot be excluded. Changes to test,
assertion, fixture, configuration, dependency or other protected inputs require full execution.
Implementation changes admitted by the independent inventory's mutable roots do not turn a
baseline failure into a passing result.

After the confirmation changes the Story revision, rebase the preserved draft and retain its
current source through the existing registered operations. Run `phase.checks.run` for that draft.
Its actual selected execution must discover every selected case exactly once. Missing, extra,
skipped, failed and timed-out cases cannot become passing evidence. Command minima for a reduced
run are explicitly bound by the reviewed selection; global Code and planned-witness requirements
remain in force.

The result includes `sflow-selective-check-summary/v1`, the original decision and unexecuted case
IDs. It explicitly makes no full-suite claim. Publication retains `test-recovery/v2` and Code
`code-delivery/v38`; excluded cases have outcome `not-run`. Verification and Release carry
`approved-code-inputs/v3` with the exact producer counts, selection and original-owner permission.
They do not claim another execution. Story evidence retains an execution-policy exception, and a
closing human vote must retain its actual final evaluation.

Expiry, revocation, source changes and environment changes are checked at the relevant lifecycle
boundaries. A later phase may obtain original-owner renewal only for the identical original scope.
A changed scope needs authoring review. To restore the original full-command agreement, revoke the
selection with an authorized `test-recovery.select-confirm` decision, rebase/retain the draft and
run its configured checks. No Story recreation or manual lifecycle commit is needed.

This first selector is bound to the original pre-feature generation. It does not carry a selection
silently into a successor Code generation. Revoke the prior selection and execute that generation's
complete configured checks; generalized successor and impact-selection owners remain in the ledger.

## Qualified artifact-phase reuse

The original reuse profile remains readable and continues to disclose
`environmentRechecked: false`. A host opts into the new contract with:

```js
const engine = createNamespaceEngine({
  ...bindings,
  checks: { ...checkBindings, environmentSensitiveReuse: true }
});
```

Bind an actual environment-qualified Node check unit for each receiving command/repository.
Its `observeEnvironment` capability verifies the pinned native executable and reads the current
checkout without starting a test process. The current observation must match the producer's actual
qualified platform, architecture, host identity, runtime digest, exact command/environment and
complete retained runner-source inventory. Dependency bytes such as `node_modules` are checked
within the explicitly selected source scope, even when application-path classification excludes them.
Explicitly excluded paths and external/network state are not attested by this profile.

`evidence-reuse.context` now returns context v2 for an opted-in host. Each candidate discloses
source/environment compatibility and an exact controlled incompatibility reason. The manifest
also offers the current-check execution route. Real missing-file, permission and timeout errors
retain their original code/details instead of becoming a fabricated compatibility result.

`decision.evidence-reuse` retains record v2 and the reviewed environment. Publication retains
`evidence-reuse/v2`, with `testsExecutedByReceiver: false`, `environmentRechecked: true` and
`failuresWaived: false`. Publication, submission and approval recheck the receiving environment.
A changed host, runtime, environment, dependency/source byte set or command requires fresh checks.
All commands/repositories in a qualified reuse set need qualified decisions; an old unqualified
record cannot be mixed in and represented as checked. Revoke an old v1 authorization before
recording its reviewed replacement rather than rewriting its receipt.

Both reuse profiles still require an artifact-only receiving phase and a real earlier approved
passing execution with the same command/repository inventory. Code receiving reuse and overrides
of the full recovery agreement's no-reuse contract remain separate owners. No fallback flag can
pretend those combinations are implemented.

## Compatibility and takeover

Old check plans v1–v4, recovery agreement v1, reuse v1, Code v1–v37 and Code-input v1–v2 keep their
existing meanings and bytes. New selective checks use plan v5 and native execution profile v3;
new report families reject unknown future versions. No installed CLI operation or Copilot skill
is silently redirected into the namespace preview.

An accepted decision, execution or publication can be replayed using shared records/content after
the original checkout and private draft are gone. Replay authenticates original receipts and raw
report/source bytes; it does not consult a new clock, read the old laptop or rerun a process.
A new action still requires its actual source, environment and authority ports. Exposing operation
wiring does not establish readiness or authorization.

The Mac qualification covers all three stores, real selected failures/timeouts, exact plan
coverage, expiry/revocation, original-owner renewal in later phases, two repositories through
Verification/Release, lost acknowledgements, preserved I/O errors, an offline-installed consumer
and NodeNext contracts. The original package qualifier and all bundle ceilings remain unchanged.
Windows qualification is not run for this slice.

The final affected Mac runs pass 474 distinct checks across 60 files, including the unchanged
34-check package qualifier in 41.6 seconds and all 13 original bundle budgets. Source validation
passes 4,417 checks; VS Code types and the original 2,011-site Git audit pass. Concurrent test/build
qualification produced one intermittent cancellation/quiescence-record failure. Its cause remains
unresolved; the isolated cancellation check, 12 additional real-process probes and the complete
serial execution suite pass. This result does not close the final combined-qualification owner.

The focused regression files are `namespace-selective-test-recovery`,
`namespace-selective-recovery-values`, `namespace-selective-recovery-edges`,
`namespace-selective-recovery-downstream`, `namespace-qualified-evidence-reuse` and
`engine-sdk-selective-reuse-package` under `test/`. Run them with the repository's isolated test
harness; the ordinary full suite remains `npm test`.
