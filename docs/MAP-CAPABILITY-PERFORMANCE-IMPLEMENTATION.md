# Map Capability performance: implementation and remaining work

This is the implementation ledger for the measured Map Capability performance plan reviewed on
2026-09-27. It distinguishes shipped read-path improvements from structural work that still needs
design and qualification. It does not claim the prototype's real-provider latency measurements as
measurements of this build.

## Implemented fast paths

| Plan item | Implemented behavior | Boundary retained |
|---|---|---|
| G0: legacy proof and read races | Prove a legacy configuration mirror from bounded exact Git objects without a checked-out application tree. Subject indexing reads one captured commit throughout. | Full asset identity and integrity proof; a live ref cannot substitute a different commit midway through the read. |
| G1: one observation per inspection | Share a remote session across authority-link, organisation, and proposal reads, primed with their combined ref selectors. | Fresh observation in each inspection; unavailable observations remain unavailable. |
| G2: exact-tip link caching | Cache both present and proven-absent links by the freshly observed state commit. Reuse complete local exact-commit objects, including when a disposable receipt needs rebuilding. Upgrade valid version-1 receipts to version 2. | Missing objects, failed reads, corrupt receipts, and incomplete cleanup are not proof of absence. Shared full-state-store reuse remains separate work. |
| G3: prefix observation coverage | A complete literal-prefix observation covers its exact descendants. Include history and review prefixes in onboarding's first observation. | Narrow observations cannot stand in for a broader inventory; failed broad observations do not hide a valid narrow retry. |
| G4: demand-loaded readiness | Do not load remote capability readiness on extension activation or workspace switch. Opening Capabilities or explicitly refreshing loads it. Reuse an already-read catalog; request blobless trees and inspect paths, not manifest contents. | Observe state/default refs each time; cache only an exact commit pair. The bounded cache is process-local, not a cross-CLI cache. |
| G5: workspace choices without Git fan-out | `workspace list --json` returns freshly validated local manifest hints. Match authority URLs locally, then inspect only the selected workspace. Show cancellable progress and discard superseded reads. | Manifest hints authorize no mutation. Unreadable manifests are disclosed, never treated as nonmatches. Selected attachment preview/apply still checks current authority. |
| G7: bounded editor reads | Queue CLI reads through one four-slot pool. Identical eligible reads share a process with independent subscriber cancellation/deadlines. Proposal inventory is a read; sensitive current-status reads remain unshared/uncached. | Writes retain their original execution and recovery behavior. Repository epochs fence late results. The final subscriber cancels the supervised invocation. |
| G8: map-return refresh | Returning from mapping uses normal fresh-ref-aware catalog reads instead of an unconditional cache-bypassing clone. | Explicit Refresh still bypasses the relevant derived cache. This is not fully local-only startup discovery. |
| G12: inspection continuation | A ready, read-only setup check can continue into inspection automatically. Continue is disabled during inspection; changed inputs or disposal abort obsolete inspections. | No automatic setup write, migration, reset, activation, or workspace attachment. |
| G13: direct inspection dispatch | Route `capability inspect-repository` directly to its command module without eagerly loading the legacy dispatcher. | Existing human/JSON output and inspection semantics remain covered by regression tests. |

Git-backed tree reads use private bare stores. Once transfer completes, temporary promisor routing
is removed before local object reads, preventing an unexpected lazy network fetch. A server that
does not support filtering may still transfer blobs; `--filter=blob:none` is not a wire-byte promise.

If subprocess termination cannot be confirmed, the result remains unknown. The supervisor detaches
its handles after bounded cleanup rather than claiming the process is dead. An incomplete object
store is preserved and cannot be reused as negative evidence or evicted as an ordinary disposable
cache entry. The four-slot pool bounds supervised invocations, not attested surviving processes.

## What the user should see

1. Open **Map a capability**, enter the repository, and choose **Check repository**.
2. If the setup is already ready, the read-only capability inspection starts without a redundant
   Continue click. Otherwise review the returned setup choice before any write.
3. During inspection, Continue is unavailable. Changing the repository cancels the old read; its
   result cannot replace the new choice.
4. **Attach existing capability** loads local workspace choices without launching a Git health scan
   for every registered workspace. Only the selected workspace receives its detailed readiness read.
5. Open **Capabilities** when readiness is needed, or use explicit **Refresh**. An unopened capability
   surface does not start remote readiness work during activation.

These changes need a rebuilt CLI and VS Code extension. They do not upgrade or rewrite an existing
repository's configuration merely by installing the build.

## Diagnostics

Opening Diagnostics also appends recent local CLI timings to the Singularity Flow output channel.
The ring contains at most 128 entries: allowlisted command/subcommand names, invocation duration,
and cleanup status. It contains no raw arguments, repository paths, remotes, credentials, or provider
output. Silent clients emit these timings too. This is local debugging evidence, not telemetry or
native-runner qualification.

The invocation timer starts after the shared read pool dispatches the command. It is not a
subscriber's total queue-plus-execution latency; measure that separately in a host benchmark.

For shell inspection and its authoring-surface entry point:

```text
Shell: singularity-flow capability inspect-repository <clone-url> --lead <authority-url> --include-proposals --json
Copilot: /sf-capability-map

Shell: singularity-flow workspace list --json
Copilot: /sf-workspaces
```

Copilot skills are guided routes, not byte-for-byte command aliases. Exact selected authority,
workspace, and current-state checks remain the CLI's responsibility.

## Deliberately remaining

| Item | Why it is separate work |
|---|---|
| G6: classifier cache split and semantic versioning | Build identity currently protects seeded defaults, schema migrations, agent contracts, and validators. Removing it without a complete dependency/version contract could reuse an obsolete setup verdict. Configuration-only projection reuse also needs exact asset proof. |
| G8: incremental snapshot slices and local-only Story discovery | The existing flattened snapshot has one receipt/stale boundary. Independent local slices need separate provenance and freshness. A no-fetch candidate route must not inadvertently run an authority-network prelude. |
| G9: multi-ref subject batching and persistent summaries | Captured-commit correctness is fixed, but a persistent cross-process cache must bind reader/version/path-policy dependencies and preserve incomplete-discovery diagnostics. |
| G10: one admitted object store across commands | The authority-link store contains only an admitted partial projection. It is not sufficient proof of the complete configuration closure required by onboarding and organisation reads. |
| G11: fewer activation pushes | Requires a recoverable multi-ref publication transaction with exact per-ref leases, audit intent, signing, lost-acknowledgement reconciliation, and supported-server fallback. Adding `--atomic` alone is insufficient. |
| G14: republish a user's legacy mirror | This changes authoritative remote state and must be an explicitly reviewed repository operation. No application repository was republished as part of this implementation. |

## Verification boundary

Regression fixtures cover shared observation counts, exact positive/negative cache invalidation,
legacy proof, captured-commit races, filtered tree reads, 48-workspace manifest matching with zero
per-workspace Git scans, independent read subscribers, queue limits, cancellation, epoch changes,
privacy-safe timings, and unknown subprocess cleanup.

macOS checks and TypeScript compilation do not qualify a real Windows/Linux office host, native
VS Code interactions, an older Git binary, or private-provider latency. The older-Git regression
checks the supported argument profile; it is not an execution claim against that Git release.
Real-provider before/after timings and those host checks remain required before making release
performance claims.

The final focused implementation batch passed 69 tests with zero skips. The workspace host batch
passed 54 tests, with additional retained-owner and safety reruns passing. Project checks (1,938),
TypeScript checking, and extension compilation passed. A broader diagnostic run found two regressions
and a stale navigation assertion; all three targeted reruns passed after correction. The all-suite
aggregate was stopped because final edits superseded its source snapshot; it did not complete and
is not a passing full-suite or release qualification receipt.
