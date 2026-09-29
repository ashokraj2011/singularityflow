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

Every freshness probe in the ledger above is unchanged: the configuration cache's authority read,
destination discovery, enrollment's live-authority comparison, the publication-permission dry run,
and the ledger reads inside publication.

## Deliberately remaining

- The reference repository transfer. It can overlap only enrollment, because the reference policy
  is known only after work-type resolution. That is the enrollment-mutation overlap below.
- Two ledger reads inside publication (building the workflow and validating it) each observe the
  state tip afresh.
- S2's speculative remote fetch and enrollment-mutation overlap; S6's unverified-manifest branch
  probes. A future approved-identity prelude is needed before such reads can safely overlap.
- Full S3 union observations, exact changed-ref fetching, and persistent cross-command
  preflight-to-Start receipts. Current reuse is private to one invocation and still proves live tips.
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
