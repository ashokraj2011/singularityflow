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
| G6 (split only): setup verdicts survive ledger writes and reach apply | A mirror or locator verdict for the state branch is reused when the observed tip's root tree, less its `ledger` entry, is identical. The bounded blobless survey that the read makes anyway proves this. The configuration verdict is keyed by its own commit. Apply reuses the verdict the preview recorded for the same commits and build. `--refresh` reads every branch again. | The build identity stays in the key. A legacy mirror's proof also needs the same observed retained-history ref. Lifecycle-only state, and asset policies that can reach `ledger/`, are reused only for their exact commit. Apply still re-observes the plan's refs, and every write keeps its exact lease. |
| G7: bounded editor reads | Queue CLI reads through one four-slot pool. Identical eligible reads share a process with independent subscriber cancellation/deadlines. Proposal inventory is a read; sensitive current-status reads remain unshared/uncached. | Writes retain their original execution and recovery behavior. Repository epochs fence late results. The final subscriber cancels the supervised invocation. |
| G8: map-return refresh | Returning from mapping uses normal fresh-ref-aware catalog reads instead of an unconditional cache-bypassing clone. | Explicit Refresh still bypasses the relevant derived cache. This is not fully local-only startup discovery. |
| G11: one activation publication | After the configuration decision, the audit entry, its pin, the retained history and the state mirror are built locally by the sequential builders and move in one atomic push. One observation before the push refuses symbolic refs and checks each lease; one after verifies every update, including when the acknowledgement was lost. Activation drops from 18 remote operations to 9. | Each ref keeps an exact lease: the observed state tip, and create-only for the history ref and pin. Commits keep the frozen identity and signing. Anything short of a verified landing, including a server without atomic pushes, runs the sequential publication, which is idempotent against an unverified landing. |
| G12: inspection continuation | A ready, read-only setup check can continue into inspection automatically. Continue is disabled during inspection; changed inputs or disposal abort obsolete inspections. | No automatic setup write, migration, reset, activation, or workspace attachment. |
| G13: direct inspection dispatch | Route `capability inspect-repository` directly to its command module without eagerly loading the legacy dispatcher. | Existing human/JSON output and inspection semantics remain covered by regression tests. |
| First-activation publication | Build the ordinary orphan ledger root, activation audit and full configuration mirror locally, then include their reachable chain in the same atomic state/pin/history publication. A delivery locator similarly publishes its first root and link in one absent-ref CAS. | The configuration decision remains separate. Current remote refs are re-observed before atomic publication; unavailable or unsupported atomic publication retains sequential, idempotent recovery. No prepared audit or mirror alone installs a state ref. Signing, canonical bytes and hook-sensitive fallback are preserved. |
| State-only delivery locators | Initialize an inert bare store in the observed repository's object format, then fetch only its exact state branch. A fresh exact-tip link receipt can prove an unchanged locator without another writer. | No application branch is fetched; only objects reachable from the selected state branch are transferred. Changed locators preserve every unrelated state file under the original observed state lease. Custom state branches, SHA-256 repositories, invalid-cache fallback and uncertain-child preservation remain covered. |
| Scoped activation reads | One immutable configuration-header batch feeds proposal asset, capability and managed-mutation validation. Effective merged configuration is validated separately; an already-validated authority definition is reused only while that same isolated checkout remains unchanged. Paired ledger-ref reads share one bounded listing. | No writer-wide read cache, cached remote authority or stale pre-merge policy. Dangling symbolic refs still require explicit probes; unavailable/truncated answers are not absence. |
| Immediate activation receipt | Both proposal panels render the successful kernel result before awaiting workspace/map refresh callbacks. `capability activate` has direct dispatch rather than loading the legacy Story handler. | UI completion requires the positive kernel attestation. Callback failures remain visible and do not cause another activation; CLI text/JSON, confirmation and recovery semantics are unchanged. |

Git-backed tree reads use private bare stores. Once transfer completes, temporary promisor routing
is removed before local object reads, preventing an unexpected lazy network fetch. A server that
does not support filtering may still transfer blobs; `--filter=blob:none` is not a wire-byte promise.

If subprocess termination cannot be confirmed, the result remains unknown. The supervisor detaches
its handles after bounded cleanup rather than claiming the process is dead. An incomplete object
store is preserved and cannot be reused as negative evidence or evicted as an ordinary disposable
cache entry. The four-slot pool bounds supervised invocations, not attested surviving processes.
Writes now invalidate derived results without cancelling unrelated reads; only a repository switch
cancels them with `CLI_READ_SUPERSEDED`. Busy or quarantined authority stores immediately use the
verified one-off reader. See [CLI cache crash safety](CLI-CACHE-CRASH-SAFETY.md) for the crash
recovery, unknown-child preservation and regression boundaries.

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
| G6: classifier semantic versioning | Build identity protects seeded defaults, schema migrations, agent contracts, and validators, so the first check after an upgrade still reads each repository again. Removing it without a complete dependency/version contract could reuse an obsolete setup verdict. |
| G8: incremental snapshot slices and local-only Story discovery | The existing flattened snapshot has one receipt/stale boundary. Independent local slices need separate provenance and freshness. A no-fetch candidate route must not inadvertently run an authority-network prelude. |
| G9: multi-ref subject batching and persistent summaries | Captured-commit correctness is fixed, but a persistent cross-process cache must bind reader/version/path-policy dependencies and preserve incomplete-discovery diagnostics. |
| G10: one admitted object store across commands | The authority-link store contains only an admitted partial projection. It is not sufficient proof of the complete configuration closure required by onboarding and organisation reads. |
| G11: the configuration decision in the same transaction | The configuration merge is still its own first push, so protected-branch review detection, the unknown-outcome recovery receipt, and concurrent identical merges keep their exact semantics. |
| G14: republish a user's legacy mirror | This changes authoritative remote state and must be an explicitly reviewed repository operation. No application repository was republished as part of this implementation. |

## Verification boundary

Run matched first-activation measurements with two clean source checkouts and lock-installed
dependencies (the control is an explicit reviewed commit, not a moving branch):

```text
node scripts/onboarding-activation-benchmark.mjs --control <CONTROL-CHECKOUT> --output <RESULT.json> --samples=3 --files=1000
```

The script alternates control/candidate and cold/prewarmed requests. Every case starts with new
local authority/delivery remotes, verifies the exact configuration and state commits, retains an
activation audit and portable delivery locator, and checks unchanged application main branches.
It records per-stage timings, Git process/remote counts, separate warm-up cost and source/bundle
identities. Cold means an empty private V8 cache, not flushed operating-system caches. Results are
CLI-only: native VS Code rendering and corporate Git-server latency need separate host evidence.

Regression fixtures cover shared observation counts, exact positive/negative cache invalidation,
legacy proof, captured-commit races, filtered tree reads, 48-workspace manifest matching with zero
per-workspace Git scans, independent read subscribers, queue limits, cancellation, epoch changes,
privacy-safe timings, and unknown subprocess cleanup.

macOS checks and TypeScript compilation do not qualify a real Windows/Linux office host, native
VS Code interactions, an older Git binary, or private-provider latency. The older-Git regression
checks the supported argument profile; it is not an execution claim against that Git release.
Real-provider before/after timings and those host checks remain required before making release
performance claims.

The earlier focused Map Capability batch passed 69 tests with zero skips. The workspace host batch
passed 54 tests, with additional retained-owner and safety reruns passing. Project checks (1,938),
TypeScript checking, and extension compilation passed. A broader diagnostic run found two regressions
and a stale navigation assertion; all three targeted reruns passed after correction. The all-suite
aggregate was stopped because final edits superseded its source snapshot; it did not complete and
is not a passing full-suite or release qualification receipt.

## First-activation qualification — 2026-10-17

The matched control is `f715f1731835a85a6b48ac67a5c69b9d270b4fe1`. The Mac candidate is
`fd56275b7351af33af36ea225cb6d3c1ebea0119`; the Windows candidate is
`fc00b423b9f5fc6da07007e3cc807bf4081494f8`. That commit and the subsequent
`b96cd364f97992d453cadac65060b577b025b152` add test-fixture corrections only, with identical
product/runtime sources. Both measurements use
Node 25.5.0, three alternating samples per variant and warmth, and 1,000 application files. Every
activation verifies the approved configuration, ledger audit, state mirror, portable locator and
unchanged application main branches. No real capability or workspace is activated.

Mac medians on Apple M4 (macOS 26.7.1, Git 2.54.0):

| Request | Control | Candidate | Reduction |
|---|---:|---:|---:|
| First activation, cold V8 cache | 2.601 s | 1.706 s | 34.4% |
| First activation, prewarmed V8 cache | 2.405 s | 1.681 s | 30.1% |

Cold ranges were 2.584–3.062 s control and 1.682–1.794 s candidate; prewarmed ranges were
2.148–2.419 s and 1.657–1.763 s. These are local-remotes CLI measurements, not operating-system
cold starts or office-provider/native-VS-Code latency claims. Prewarming cost is recorded
separately rather than counted as free preparation. Review/catalog latency is not claimed improved.

Native Windows CI medians (OS 10.0.26100, Git 2.56.0.windows.2):

| Request | Control | Candidate | Reduction |
|---|---:|---:|---:|
| First activation, cold V8 cache | 15.715 s | 10.644 s | 32.3% |
| First activation, prewarmed V8 cache | 15.502 s | 11.234 s | 27.5% |

Cold ranges were 15.456–24.052 s control and 10.524–11.070 s candidate; prewarmed ranges were
15.172–23.697 s and 10.387–11.631 s. The small sample and runner variance do not establish a
general cold-versus-prewarmed ordering. Both platform runs retained 36 successful requests each.
The Windows benchmark job passed in retained qualification run `39027284881`;
that run's separate regression job exposed the test-fixture transport issue described below and
was not an overall passing regression receipt. This is native Windows execution against local
remotes, not qualification of a particular office laptop, Defender configuration or corporate WAN.

Every measured activation uses 139 Git processes instead of 211, 13 remote Git commands instead
of 26, four pushes instead of nine, and one clone instead of two. The remaining clone is the
configuration checkout; the delivery application branch is no longer cloned for its locator.
Candidate Windows counters attribute 8.491–9.713 s to aggregate Git service time; the main
configuration YAML parse span is only 8.4–9.4 ms. Those service counters are not an additive
end-to-end wall-time decomposition, but identify remaining Git work rather than YAML parsing as
the next measured target. No further remote-authority or signing checks were removed to lower it.

Mac validation passed the 182-test capability suite, the 175-test ledger/onboarding/transport
batch, 63 cache/lease/activation tests after portability corrections, the full 61-test portable
ledger rerun, two completion-before-refresh UI tests and three publication smoke tests. These
batches overlap and are not a whole-repository test count. All had zero failures and zero skips.
Extension compilation, TypeScript checking and all 2,673 repository checks passed.

Windows qualification also exposed and corrected a derived-cache recovery bug: synthetic Windows
mode bits must not be interpreted as POSIX permissions. Exact owner/death, nonce/inode, link and
successor fences remain enforced; unknown-child stores are still preserved. The race tests now use
the existing native executable test bridge, not Unix-only PATH scripts or a production Git-policy
exception. The .NET compiler is a test-fixture requirement, not a new product runtime dependency.
Those fixtures freeze the normal approved enterprise transport environment so Windows `Path` /
`PATH` spellings cannot silently select a different executable at the remote boundary.

The final Windows regression receipt is retained run `39027981266`: the complete ledger file
passed 50 tests with 11 existing POSIX-only skips, including both corrected native race cases;
both built-extension completion tests passed with zero skips. Extension build, TypeScript checking
and all 2,673 repository checks passed. The identical-runtime activation/cache/lease batch in
`39027284881` passed 61 tests with four POSIX signal-fixture skips. No failed test is counted as a
pass; the earlier failed runs are retained separately. The final rerun deliberately reuses the
already-completed benchmark rather than measuring the same unchanged runtime again.

All hosted qualification files live only on a disposable CI branch, never on production main.
Raw JSON measurements and TAP receipts are retained outside the source checkout; production
contains the reproducible benchmark script and this bounded record, not machine-specific paths.
