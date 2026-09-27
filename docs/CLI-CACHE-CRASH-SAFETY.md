# CLI cache crash safety and read cancellation

Verification and implementation ledger for the cache spec reviewed on 2026-09-27. All four
reported defects were present in the reviewed source. The supplied historical timings are not
measurements of this build.

## Verified defects and corrections

| ID | Verified behavior before correction | Implemented correction |
|---|---|---|
| BR-1 | Writes and unrecognised commands cancelled unrelated queued and running VS Code reads. | Invalidate results and in-flight sharing without cancelling existing subscribers. Epochs keep their late results out of the new cache. |
| BR-2 | An occupied authority-store marker returned an unavailable result without reaching the independent reader. | Busy, damaged and quarantined caches use the original exact-ref, bounded one-off reader. A cache receipt can be written only under the healthy store lease. |
| BR-3 | The configuration allocator remained held across Git work; an interrupted UUID lock imposed the repeated five-second wait. | The allocator covers only local admission and is released before Git or snapshot validation. Contention uses a 250 ms wait budget before bypass. Owner records permit proven-dead recovery. |
| BR-4 | Full configuration caches declined every subsequent commit without eviction. | Evict idle entries in least-recently-used order, prioritising safely reclaimable dead-owner entries. Never evict live, foreign or unknown-child entries. |

Repository switching still cancels obsolete reads, with `CLI_READ_SUPERSEDED`. The Store does not
publish an error or recovery snapshot for this cancellation, and Story discovery does not turn it
into a needs-attention issue. Explicit subscriber cancellation and deadlines retain their separate
semantics.

The extension's literal command calls are checked against the CLI operation registry. The audit
covers complete literal argv and critical dynamic-route cases; it is not an enumeration of every
possible runtime argument. Jira status is GET-only, and prompt-log status/list/view leave existing
audit files unchanged. Unknown command forms remain conservatively classified as mutations.

## Safety corrections to the supplied spec

Time alone cannot prove that a child process exited. R2.4's fifteen-minute alternative and R2.5's
automatic retirement of old operation markers were therefore not adopted for per-store leases.

- A same-host, provably dead owner can be reclaimed only when the record has no unknown children
  and every recorded child is provably dead. `ESRCH` is the death proof; permission failures are not.
- Live owners, foreign-host owners and unknown-child quarantines are preserved regardless of age.
- Legacy per-store markers contain no trustworthy child identity. They remain preserved, while
  the verified uncached reader continues immediately without waiting for that store.
- Legacy allocation-only UUID or empty acquisition records may be recovered after
  fifteen minutes. The allocator never guards a native Git child in the corrected implementation.
- Damaged or future owner-record formats are not reinterpreted as age-reclaimable legacy locks.
- The current subprocess adapters do not return a trusted child/process-domain identity. The
  implementation records `unknownChildren: true` before dispatch rather than inventing a PID.

A reclaimed store is moved aside before rebuilding; its old objects are never reused as evidence.
Permanent atomic reclaim fences prevent a paused reclaimer from retiring a live successor. The
workspace-registry lease retains its existing heartbeat, expiry and race protocol in the shared
module. The publication/subject-lock protocol is unchanged.

## Signals and fallback

CLI entry installs reference-counted SIGTERM, SIGINT and SIGHUP handlers when an embedding caller
does not already own those signals. Cleanup checks the held descriptor, inode and exact nonce
bytes, preserves protected operations, then re-raises the signal to retain native exit semantics.
The cleanup loop has a 100 ms best-effort budget. Synchronous filesystem calls cannot provide a
hard wall-clock guarantee on a stalled filesystem; dead-owner recovery and cache bypass remain
the fallback for SIGKILL, crashes and incomplete signal cleanup. The allocator's 250 ms contention
budget likewise bounds polling and sleeps, not wall-clock time on a stalled local filesystem.

Cache failures do not relax authority validation. Configuration snapshots still use the existing
validators on a disposable, non-hardlinked checkout. Authority links still use freshly observed,
exact remote commits and bounded reads. Transport outages and semantic validation errors retain
their original refusal behavior. An unknown cache child fences that cache, not the independent
reader. A later uncached failure is still a real failure, not proof of absence.

## Admission and diagnostics

The configuration cache retains its limits: 32 exact-commit entries, 256 MiB stored bytes and
16,384 stored files/directories, plus the existing per-tree, per-blob and logical-content limits.
An entry's modification time records a verified-object reuse attempt while its lease is held;
the disposable checkout and snapshot validators still run afterward. Entry limits are
retained/admission bounds, not a strict peak transfer or allocation guarantee. Active fills may
temporarily overlap; post-fill accounting evicts idle entries or declines the new entry.

Permanent reclaim fences consume the storage budget. Safely retired stores are removed best
effort outside the active namespace; failed cleanup may retain those never-readable tombstones.
Unknown-child stores are not automatically deleted to regain quota. When safe admission is
impossible, the independent reader is used.

Counters contain fixed reason names only, never paths, URLs, credentials or repository content:

- `cache.lease-reclaimed-dead-owner`, `cache.lease-reclaimed-dead-quarantine` and
  `cache.lease-reclaimed-legacy-stale`
- `configuration.object-cache-evicted`
- `configuration.object-cache-allocation-timeout`
- `capability-authority.cache-bypassed.disabled`, `.busy` and `.local-failure`

## Verification boundary

Regression fixtures cover write/read isolation, repository-switch cancellation, classifier parity,
Store/discovery cancellation, actual POSIX signal exits, successor preservation, dead owners,
live/unknown children, legacy markers, concurrent slow fills, busy allocators, 33 distinct commits,
live-entry preservation, dead-owner priority, byte limits and the 16,384-file limit. Actual
configuration-reader SIGTERM/SIGKILL fixtures retain uncertain operation markers and verify the
next read succeeds through fallback in under one second on the local fixture.

These tests do not qualify native Windows execution, office-provider latency or native VS Code
first paint. The configuration cache remains disabled on Windows, and gateway/default cache-off
readers remain cache-off. No repository schema migration or authoritative data reset is required.
Users need a rebuilt CLI and VS Code extension to receive the fixes.

The final focused cache/publication/Story-start batch passed 304/304 tests with zero skips.
Project checks (1,955), VS Code typecheck and extension build also passed. Broad-suite execution
found two stale integration assertions and a fixture race with automatic Git maintenance; those
tests were corrected without changing production behavior, and their focused reruns passed.
The broad aggregate was stopped after its source selection was superseded by those test changes,
so it is not a clean full-suite or release qualification receipt. One separately reproduced,
pre-existing failure remains in `test/cli-failure-presentation.test.mjs`: `start --verbose` with no
work ID is rejected before the legacy command logger is created. This is not a cache regression.
