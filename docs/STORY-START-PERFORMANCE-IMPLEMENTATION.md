# Story-start performance: implementation and verification boundaries

Implementation ledger for the Story-start plan reviewed on 2026-09-27. The supplied timings came
from older builds and different fixtures. They identify useful candidates, not a measured baseline
or a latency guarantee for this build.

## Corrections to the plan

- Named `start.*` spans already survive in durable command timings. VS Code already includes an
  allowlisted subcommand in its timing line. Regression coverage now locks that behavior down.
- `workspace branches --intake` already prefers the latest approved configuration. A regression
  test now verifies that an older Story pin cannot supply the next Story's workflow catalog.
- A Git blob is not necessarily identical to checked-out bytes: attributes, line endings, encoding,
  filters and file modes matter. Cache reuse must preserve the existing snapshot validation path.
- A successful Start result is not a governed repository snapshot. It cannot establish session
  readiness, approval, configuration freshness or lifecycle state in the newly opened window.
- Fetching an unapproved default remote, or probing repositories from an unverified manifest, is
  not harmless speculation. Those proposed overlaps were not adopted.

## Implemented behavior

| Plan item | Delivered | Safeguard retained |
|---|---|---|
| S0: measurements | Regression for durable overlapping stage spans and privacy-safe timing output. | Stage durations may overlap; do not sum them as total elapsed time. No repository content, raw arguments or credentials are recorded. |
| S1: configuration object reuse | Explicit CLI intake, preflight and Start reads may reuse a private exact-commit configuration object store. | Every cache read freshly observes authority. The existing complete snapshot validators still run on a disposable local checkout. Default and gateway readers remain cache-off. |
| S2: independent reads | After configuration selects the approved application remote, destination discovery overlaps an explicitly requested tracker read. | Both owners settle before cleanup or refusal. Destination retains first-refusal precedence; tracker errors are consumed at their existing checkpoint. Enrollment writes are not speculated. |
| S3: partial observation seam | Destination discovery includes the explicitly selected base and Story ref, and uses an operation-local remote session. | Later mutation probes remain fresh. This seam does not claim a reduced probe count by itself or complete the proposed one-probe-per-remote design. |
| S4: duplicate lifecycle fetch | Capability preflight can reuse the launch checkout's fetch after a fresh exact-ref probe. | Remote identity, Git common directory, base and state tips must still match, and the Story destination must remain absent. Moved tips, stale tracking refs, or failed reuse proof take the normal prune-fetch path. |
| S5: sibling publication | Push siblings in input-ordered waves of at most four, rather than serially. | Persist the whole wave's in-flight recovery record before dispatch. Settle every launched push; stop later waves after refusal. Concurrent successes and lost-acknowledgement recovery remain recorded. |
| S7: post-start activation | Store one short-lived, machine-local scheduling hint before opening the published Story checkout. Defer optional workspace-wide Story discovery for five seconds when a fresh local snapshot matches it exactly. | The new window still reads its own core snapshot. Exact checkout, Story, branch, HEAD and configuration pin must match within two minutes. Explicit Refresh runs immediately; switching or disposal cancels the pending timer. No synthetic readiness or session is created. |
| S8: cheap refusals | Reject invalid portable IDs, incompatible source/base options and an ungoverned local branch collision before authority fetch or isolated setup. | The selected workflow still enforces its own ID policy. Valid configured namespaces are not narrowed by a hard-coded default pattern. Existing governed Stories and seeds retain their separate handling. |
| S9: tracked intake | Share one destination inventory fetch within a Start invocation. | Later base and publication checks remain fresh. No persistent stable-ID index is introduced. |

### Configuration-cache profile

The initial cache profile supports direct `sflow/config` authority reads on POSIX hosts. Windows,
state-mirror authorities, committed attributes/submodules, unsupported modes and ambiguous path
aliases retain the original remote-clone path. A warm supported read avoids repeated remote object
transfer, not all Git processes: it still observes the live ref and makes a local non-hardlinked
checkout for the unchanged validators.

The default store is `~/.singularity-flow/cache/story-configuration/v1`. An isolated lead-registry
setting places it alongside that registry instead. `SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE=off`
disables reuse; an absolute path selects a private cache root. Existing roots must already be
current-user-owned and private; SFlow does not chmod an arbitrary caller-owned directory.

Admission limits are 32 exact-commit entries, 4,096 tree files, 8 MiB per blob, 64 MiB logical content,
and 256 MiB retained storage. Stored metadata, object integrity, modes, paths, ownership and storage
bounds are checked before reuse. Limits are admission/retained-storage limits, not a strict peak
wire-byte or disk-allocation promise during transfer. An over-budget or unsupported completed read
falls back to the original path.

An unconfirmed native-process outcome leaves a quarantine marker and any private checkout intact;
it cannot admit a cached snapshot or permit automatic cleanup. An exceptional snapshot validation
also preserves those private paths and its original diagnostic. Safely proven dead-owner entries
can now be rebuilt, and idle entries are evicted under the short allocation lease. Unknown-child
quarantines remain preserved regardless of age and consume quota; reads immediately bypass those
entries without deleting preserved evidence. See [CLI cache crash safety](CLI-CACHE-CRASH-SAFETY.md)
for the lease, signal, fallback and eviction rules.

The one new local Git wrapper was reviewed separately in the Git bypass audit: fixed internal
cache commands, disabled hooks/maintenance, bounded buffers/timeouts, isolated transport and
completion checks. Removing the destination reader's ambient `git remote get-url` call offsets one
legacy direct site. The audit baseline was updated only for those two reviewed files.

### User-facing routes

The optimized paths are automatic in a rebuilt CLI and extension; no repository schema migration
is required. Existing accepted Stories retain their pinned execution configuration.

```text
Shell: singularity-flow workspace branches --json --intake
Copilot: /sf-start

Shell: singularity-flow start <work-id> --from-branch <base> --isolated-worktree --json --timings
Copilot: /sf-start

Shell: singularity-flow session candidates --json --diagnostics
Copilot: /sf-session
```

Skills are guided entry points, not byte-for-byte aliases. They must use the returned repository,
selection and legal next action. VS Code's Inbox **Refresh Stories** bypasses the idle delay.

## 2026-09-29: a measured reference-driven start

A real reference-driven Story start, launched from VS Code inside an existing Story worktree against
a private GitHub repository, took 31.7 seconds. Its durable timing record and a replay against local
mirrors of the same repositories attributed the time:

- 16 network round trips (the 17th remote command is a local clone from the configuration object
  cache). Seven were in publication, which took 14.9 seconds.
- 2.35 seconds of root dispatch: the product-requirement check read approved configuration again
  (probe, clone, validation) because its verdict was keyed by the asking worktree.
- About 7.4 seconds outside every span, mostly the reference repository: an 11 MiB depth-1 pack of
  about 3,000 objects.
- Four `gh api user` calls. The account cache lived at `<root>/.git/...`, which is a pointer file in
  a linked worktree, so it was never written there.

| Change | Delivered | Safeguard retained |
|---|---|---|
| Shared Git directory | The GitHub-account, epic-source and agent caches resolve the common Git directory from the filesystem (pointer file, then `commondir`). | Read paths still never spawn Git. A main checkout's paths are unchanged. |
| One requirement verdict per repository | Verdicts are keyed by the main checkout that owns the shared Git directory, so every Story worktree shares one daily check. | A main checkout's key is unchanged. The requirement is still read before any mutation when due. |
| Atomic ledger tail | Every lifecycle publication appends its ledger entry and pin in one atomic push after one lease observation. The sequential tail used four round trips. | Exact leases: the observed state tip, and create-only for the pin. A clean per-ref acknowledgement or a verifying observation is required. Anything else runs the sequential append, which starts from a fresh state observation when the push may have landed. The first observation is bounded at 10 seconds. |
| Timing | `start.reference-pins`, `start.references` and `dispatch.*` spans. Dispatch passes now count their Git work. | Recorded only when the step runs. Names are fixed vocabulary. |

Replay of the same start from a Story worktree (local mirrors, so network time is absent): 17 remote
commands became 15, `gh api user` calls went from 4 to 1, root dispatch went from about 590 ms to
50 ms, and wall time went from about 10.1 to 7.9 seconds. At the measured 1.2 to 3.2 seconds per
authenticated GitHub operation, the projected saving on the original network is about 7 seconds. That
projection has not been measured on the real network.

## 2026-09-29, second round: one look, one check, one push

After the first round, a start still made 14 network round trips, most of them re-asking a remote a
question the same command had answered seconds earlier. The refs a start writes are protected by
exact leases on its push, so the only re-check that buys anything is one confirmation, before the
first shared mutation, that approved configuration did not move. A start now makes 7:

| Round trip | Purpose |
|---|---|
| Authority observation | Selects approved configuration. The configuration read reuses it (opt-in, start only; every other cache read still observes). |
| Launch fetch | Brings the base, and the state tip, into the new worktree. |
| Destination discovery | Default branch, base and Story ref, and now the state tip. Capability preflight's launch-fetch reuse proof answers from it instead of probing the same refs. |
| Publication-permission dry run | Unchanged. It proves write access before anything local happens. |
| Reference fetch | When automatic enrollment cannot publish, the depth-1 fetch of the branch pins the commit it transfers; the separate resolution only ever existed to refuse before a membership commit. |
| Authority check | One fresh look at `sflow/config` (and `state` on the same remote) before the first shared mutation. It replaces enrollment's own probe, runs even when enrollment is switched off, answers enrollment's resolution through the start's session, and seeds publication's ledger reads. |
| Atomic publication | The Story branch, its ledger entry and the entry's pin in one push. |

| Change | Safeguard retained |
|---|---|
| Configuration read reuses the authority observation | Only the start opts in, and its authority check refuses if the tip moved before the first shared mutation. Cache metadata and pins are still never authority. |
| Ledger reads answer from the authority check | Only while the tracking ref already names that exact commit; otherwise the read observes afresh, so a concurrent append is seen, never refused. Every ledger publication forgets the view, and a retry after an uncertain push never uses one. |
| Branch, entry and pin in one atomic push | Exact leases: the branch's expected tip (absent for a new Story), the state tip the entry extends, absent for the pin. A clean per-ref acknowledgement or a verifying observation is required. A refusal publishes sequentially, skipping the ledger's own atomic attempt; an unverifiable outcome is recorded as transport-indeterminate, which pending-publication recovery already reconciles. |
| Reference resolution through its fetch | Only when enrollment cannot publish. A failed fetch falls back to the separate resolution, which classifies a missing branch or unreachable remote exactly as before. |

Every lifecycle publication benefits from the combined push, not only the start: approvals and phase
transitions publish their branch and ledger entry together too.

Replay of the user's reference-driven start from a Story worktree: 16 network round trips before
either round, 14 after the first, 7 now (two fetches, three observations, two pushes), with one
`gh api user` call and a shared requirement verdict. An authority change injected just after
destination discovery is refused at the authority check with nothing published, as before but with
half the probes. Network savings are projected from the measured per-operation cost, not measured
on the original network.

## 2026-09-29, third round: start verifies what intake saw

Intake already proves everything a start needs: a passing readiness preview has listed approved
configuration, fetched the base, observed the Story destination and the state tip, and dry-run
publication, usually seconds before Start. Without that knowledge a start discovers its inputs one
at a time, because each answer names the next question. A preview can now seal what it proved into
a machine-local intake receipt, and a start that presents it runs one concurrent wave instead:

| Round trips | Without a receipt | With a receipt |
|---|---|---|
| Configuration, destination, base probe, pre-mutation check | 4 listings, one after another | 1 listing (2 when configuration lives on another remote) |
| Base fetch | 1 | 0 while the tip is unchanged; a moved state tip costs one fetch of that ref |
| Publication dry run | 1, after the listings | 1, alongside the listing |
| Publication | 1 | 1 |

Measured on local fixtures: 7 network operations in 7 sequential round trips became 3 operations in
2 (the wave, then the push). The Story created is the same either way apart from its own ID and
title. The catalog and its preview also list approved authority once instead of twice.

| Safeguard | How |
|---|---|
| The receipt authorizes nothing | Every governed input is observed again, the dry run is fresh, readiness is recomputed, and the wave's authority observation stands in for the pre-mutation check for at most 30 seconds. |
| Anything unusual takes the ordinary path | Expired, edited, foreign, reused, another build, checkout or request, a moved base or configuration, an existing destination or a refused dry run; `data.intakeReceipt` reports the reason. |
| Reuse is private | The proof exists only inside one start process; it is never accepted from a flag or a file. |
| Kill switch | `SINGULARITY_FLOW_STORY_INTAKE_RECEIPTS=off`. |

## 2026-09-29, fourth round: intake works while the person types

| Change | Effect | Safeguard retained |
|---|---|---|
| Reference prefetch | A completed reference row fetches its pinned commit into a machine-local store; Start copies it instead of transferring it. With a receipt, a Start with a reference now fetches nothing. | Start resolves every pin itself; the store serves only that exact commit, Git verifies every object, and the origin still names the real repository. |
| One listing for the catalog | Authority resolution and the base inventory share one all-heads listing of the checkout's own origin: 1 round trip instead of 2 (3 before this series). | Only the own origin, only while the repository plan names exactly that URL. |
| One listing for the preview | The authority listing also carries the base, destination and state refs; the preview skips its fetch when the tracking refs already match: 2 round trips instead of 3. | A moved tip is fetched as before; a separate workspace authority keeps the ordinary path. |
| Start progress | The engine names each stage on stderr when asked (`SINGULARITY_FLOW_PROGRESS=stderr-v1`); VS Code shows it in the form and notification. | Fixed stage names only; stripped before stderr is shown or parsed; never inherited by child processes. |
| New window first | A window's first repository read runs at interactive priority, and in a window opened for a just-started Story the product checks wait for the idle period. | Optional work only waits; explicit actions never do. |
| Selection receipts in isolated starts | A Copilot selection receipt now drives an isolated start: read and checked in the launch checkout, handed over in process, consumed there. | The same session, HEAD and answer checks; the base is observed by start before any change. |

## Deliberately remaining

- The publication-permission dry run (one round trip). Dropping it would turn a revoked permission
  into a retained local commit with a pending push instead of a clean refusal.
- The reference repository transfer itself (an 11 MiB pack for the measured Story). Fetching only
  its commit and tree at start and the blobs on first use would change the intake contract.
- S2's speculative remote fetch and enrollment-mutation overlap; S6's unverified-manifest branch
  probes. A future approved-identity prelude is needed before such reads can safely overlap.
- Receipts for capability Stories (several repositories) and on Windows; those starts still take
  the full path. Exact changed-ref fetching generally.
- The warm-up (`workspace branches --intake --warm`) and its sealed approved-identity prelude were
  not built. Without them no read may start before approved identity is verified, so the catalog's
  listing and a preview's dry run still follow the authority listing rather than overlap it.
- Trimming the roughly 475 local Git processes a start spawns.
- A shared G10 configuration/state object service, Windows cache qualification, and transform-aware
  projection reuse. This restricted configuration cache does not complete G10.
- Fully local-only activation discovery, independently proven snapshot slices and persistent
  changed-tip subject indexes. Core authority reads and ordinary background discovery still exist.
- Real private-provider before/after measurements, native VS Code first-paint checks, Windows/Linux
  execution and one complete release aggregate against the final committed source.

## Verification

Local fixtures cover cold/warm exact configuration reuse, byte and executable-mode preservation,
SKP dependencies, fresh authority changes/outages, concurrency, corruption and quota declines,
native overflow/quarantine, cheap refusals, configured ID policy, tracked-read overlap, unchanged
base reuse, moved state/base tips, stale Story tracking refs, and bounded sibling publication.

Publication fault fixtures kill a process after multiple sibling refs land, reconcile only exact
recorded tips, and publish the untouched tail. A separate real local-remote fixture verifies a
rejected sibling does not erase a concurrent success or launch the next wave. Handoff tests bind
the hint to confirmed lifecycle and exact configuration identity; invalid hints use normal startup.

These are deterministic behavior and call-count regressions, not office-network performance or
native-host release evidence. The proposed 85-second to 15–20-second journey reduction has not been
measured on this build and is not claimed as achieved.

The broader macOS regression batch passed 331 tests with zero skips. The complete publication-fault
file passed 128 tests with zero skips, including multi-sibling crash recovery. Seven selected tests
against the built extension host passed, including real published-Story handoff, pin mismatch,
explicit Refresh cancellation, normal intake, attachment and workspace switching. Project checks
(1,945), TypeScript checking and extension compilation passed. Additional final cache/reader and
CLI-shape tests were run after the explicit intake cache wiring. No full all-suite aggregate,
native Windows/Linux run or private-provider before/after measurement is claimed by this ledger.
