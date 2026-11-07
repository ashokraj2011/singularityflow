# Draft inspection

`engine.run('phase.draft-check', {workId?, phaseId?})` and `engine.draftCheckPhase(inputs)` inspect
the current review draft through the operation registry. The CLI's `phase draft-check` uses the
same coordinator. The existing Git checker remains the concrete observation owner.

## Meaning and boundary

Draft health is narrower than publication readiness. A draft result of `ready` means its native
authored-content finding list is empty. It does not inspect the complete publication worktree
gate, run required tests, admit a publication attempt or verify final transaction bindings.
For example, a finished draft may be ready while prepublish correctly requires human review of
already staged files. Publication retains all its own checks.

The kernel captures the Story, phase status and inspection generation before the awaited native
check. Retained and submitted generations keep their exact generation; inactive phases retain
their refusal. Selection does not enumerate unrelated artifacts or submission history. Custom
phase names use the same semantic generation and finding rules.

The public `sflow-phase-draft-manifest/v1` contains:

- the captured Story, phase, generation, inspection stage and `inspectionScope: authored-draft`;
- producer, quality disposition and fingerprint, without artifact or prompt bodies;
- findings with original diagnostic text, canonical identity, affected phase and kernel policy;
- advisories with their deadline, upstream owner and issue links, separate from findings;
- native correction suggestions and local task identity, state and continuation budget;
- `draftReady`, with `publicationReadinessInspected`, final-binding, test-execution, mutation-
  authority, approval and human-review flags explicitly false.

There is no publication-readiness or `admittedForAttempt` field. An upstream owner that is not
known remains unknown. Risk eligibility never records acceptance. An interrupted task or spent
budget remains visible without being reset or granting edit authority.

## Compatibility

The Git port loads one accepted Story and the existing session and native checker. It observes
the local task check and reads its continuation exactly as the previous CLI path did. The shared
prepublish port keeps its existing native observation sequence; it does not duplicate that task
observation. Host model mode and authorship presentation are trusted constructor preferences,
not operation fields a caller can use to assume an actor or provider.

The CLI retains its original human display, JSON, exact issued paths, recovery choices and
agent hook recording. None of that presentation is imported by the pure SDK. The checker and
SDK use the same pure draft-health rule and finding classifier. The SDK receipt explicitly
reports that local progress may be written; draft bytes, source, Git index, commits, lifecycle
and approvals remain unchanged by this inspection.

Native errors keep identity, code, cause and recovery. Optional `enginePhaseDraftCheck`
diagnostics identify completed and pending stages and possible local progress; frozen or
read-only error properties cannot mask the original failure. Cancellation does not retry a
check or assert that its local observations were rolled back.

This delivery preserves the installed Story-branch lifecycle authority, state proof/projection
and approved configuration authority. It adds no storage cutover or alternate writer. Native
finding collection, preparation and rollover remain explicit compatibility dependencies; the
[migration plan](ENGINE-SDK-MIGRATION.md) retains their complete remaining scope.

## Local qualification

On macOS 26.7.2 with Node 26.12.0, 336 focused checks across 23 files pass without failures,
cancellations or skips. They include real SDK/source-CLI/bundled-CLI parity, authored versus
publication readiness, retained-generation recovery, all-phase native checks and repair loops,
edit guards, upstream obligations, a complete honest-verdict Story and existing Git compatibility
conformance. The CLI renderer retains all 483 predecessor syntax tokens.

Source validation passes 3,626 checks. VS Code typechecking, all 13 unchanged bundle budgets,
Git ownership audit and dry-run packaging pass. The pure SDK has 17 modules / 211,450 input
bytes and zero external imports; the gateway remains 851 modules / 6,742,680 bytes. The package
contains 9,482 files, including this contract and the adapter, and excludes test fixtures. All
machine state, repositories and remotes are isolated fixtures. No Windows, hosted CI, live
provider, installation change or real-project migration ran.
