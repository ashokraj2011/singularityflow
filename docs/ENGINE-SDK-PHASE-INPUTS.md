# Phase-input preparation through the Engine SDK

`engine.run('phase.inputs', { workId, phaseId, dryRun })` previews or prepares the phase's existing
input dataflow. The CLI's `inputs` route uses the same operation. Work and phase selections are
optional for a bound native host; `dryRun` is a boolean and defaults to false. Native state,
identity, roots, captured records, source bodies and callbacks cannot be supplied as operation
inputs. Configured generation continues through the separate `phase.prepare` operation.

## Ownership

The SDK coordinates `load`, `prepare` and `inspect`. The kernel binds the target generation,
owns input severity/readiness and audit-selection rules, and validates the body-free observation
manifest. The installed input collector, draft writer, renderer and exact artifact inspection
remain native services. Approval/sequence, required documents, references, pending publication,
test-policy and code-generation admission keep their original native checks.

The Git port reuses `preparePhaseInputs` and the existing `storyDraftTransaction`/`saveStoryDraft`
boundary. The CLI retains its entry preflight and private accepted context; it performs no second
input preparation or artifact-byte read. The input service captures artifact/audit observations
once and reuses them for the SDK receipt and CLI projection.

`inputFindingSeverity` and `inputReadinessFindings` now have one kernel owner. Their old imports
re-export the same functions. The audit condition is shared with both native preparation paths,
including skill phases and ordinary declared phase inputs. No input-record schema, rendering,
hash, authoring baseline, surgical reopen or telemetry rule is changed.

Artifact-byte inspection belongs to the native input service. The old presentation import of
`phaseInputArtifacts` remains a compatibility re-export. The presentation module formats labels
and continuation; it contains no filesystem reads or hashing.

## Manifest

The result uses `sflow-phase-input-manifest/v1`. It records work, phase, generation, configured
input mode, observations and counts. It contains no source body, model prompt or rendered command
guidance. Its logical keys identify resources without selecting a laptop's checkout or database.

| Observation | Binding |
|---|---|
| Primary artifact | Logical key, observed byte count/hash and managed-block comparison when prepared |
| Input audit | Exact key/hash/generation, with whether it belongs to this prepared generation and was recorded by this invocation |
| Producer input | Phase, output when applicable, generation, policy status, optionality and approved/observed source digests |
| Selected representation | Full, truncated, clause-selected or approved-summary digest, bytes, explicit truncation/completeness and retained expansion handle |
| Read budget | Configured source/summary byte limits, preserving whole-source fallback and the actual representation size |
| Approved summary | Retained brief key/hash in addition to the original producer source binding |
| Skill output | Exact approved-generation receipt, source revision, submitted/approved hashes, bundle bindings and acceptance kind |
| Readiness | Error, warning, remote-warning and remote-output counts under the configured mode |

Captured inputs require approved producer status and matching registered/current source bytes.
A summary also names its retained brief. Skill receipts bind the selected output's producer
generation and current approved bytes. Unknown statuses, differently bound observations, malformed
references and body-bearing records cannot become successful SDK receipts. Clause selections
preserve the actual selected IDs. A summary's smaller representation does not imply truncation
or completeness of the original document.

The input mode retains its meaning: `off`, `record` or `enforce`. A `record` mode may permit a
preparation while reporting a mismatched source as an advisory. `ready` means the configured input
policy is satisfied at inspection; the per-input status and digests still disclose any mismatch.
It does not establish completed authoring, fresh publication admission, consumed context or human
review. Final publication still verifies its own bindings and required checks.

## Preview, writes and recovery

A normal preparation records the existing audit when required, prepares the managed artifact and
can open the existing local code-generation intent. The SDK reports an opened intent only when
the native intent changed to open. Binary artifact bytes and preserved authored text follow their
existing native rules. There is no model invocation, test run, commit, push, approval or phase
advancement in this operation.

`dryRun` returns `status: inspected` and keeps missing or changed approved inputs visible. It
does not prepare the primary artifact, write an input audit or open a code generation. The native
flow may materialize local resources and write machine-local task progress even during preview;
the effect record explicitly reports `localProgressMayBeWritten`. The operation is not advertised
as a side-effect-free filesystem query.

Native missing-document, permission, input-readiness, authority and pending-publication refusals
retain their exact code, cause and recovery details. Cancellation after native preparation or an
inspection failure carries `enginePhaseInputs` diagnostics: completed/pending stages, the bound
generation and whether local preparation effects may exist. No failure is converted into a claim
that a publication or approval occurred. Existing restore/owner routes and human wording remain
in the native CLI readiness report, outside the provider-neutral manifest.

## Qualification and remaining work

Pure contract tests cover custom phases, advisory/enforced input policy, unknown statuses, exact
summary/skill receipts, denied input injection, cancellation and preserved native failures. Real
disposable Story tests inspect genuinely approved producer inputs, compare the CLI's captured SDK
receipt, verify native audit hashes, preserve missing-input recovery routes and execute a built
CLI plus bounded agent preview. Compatibility exports retain function identity.

This is the phase-input slice of Phase 5 in [the migration](ENGINE-SDK-MIGRATION.md). The complete
native admission/rendering service is still an explicitly owned compatibility collaborator.
Remaining queries/native policy extraction, portable lifecycle writers, complete headless Story
execution and verified authority cutover retain their scope. Existing Git authority and local
attachment behavior are unchanged. This branch is qualified on Mac only.

Mac qualification on macOS 26.7.2 / Node 26.12.0 passed 149 checks across 16 files with zero
failures, cancellations or skips. It includes the actual bundled agent/CLI paths, missing-source
restoration, approved-summary projection, skill input receipts, binary artifact lifecycle,
configured preparation parity, namespace readers, packed SDK consumers and architecture guards.
Source validation passed 3,685 checks; VS Code typechecking, Git ownership audit, all 13 unchanged
bundle budgets, dry-run npm packaging and whitespace checks passed. The gateway has 852 modules /
6,750,279 bytes. The SDK archive includes 39 registered operations and 50 owned source modules.
These are compatibility and artifact measurements; no command-speed claim is made here.
