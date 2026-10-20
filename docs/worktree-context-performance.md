# Shared worktree and cold phase performance

## Scope

This change removes repeated advisory worktree observations and unnecessary installed-bundle
loading from bound `phase enter`, composed phase entry, and agent `nextsteps` requests. It does
not skip lifecycle authorization, accept stale mutable state, or turn a drafting hint into
publication readiness.

The measured runtime is `00f1f8140fb63bbbf06d9a9dbc4d6f2109d752ef`, compared with main at
`447fe90433667deaf4ada23d78c72030aaa6467a`. Subsequent test-only portability corrections
`326a8da25e24c4bfd3bb4486baa82e72004175a9` and
`784c8239896e75c070584cd0822fcc1658bcb343` change no runtime or benchmark code.

## Changes

- A read-only recovery operation shares one lossless porcelain-v2 observation. Ordinary paths
  can supply status, changed paths and a clean-index proof without more status/diff/history
  queries. Renames, submodules, conflicts, quoted/byte paths and ambient index selectors retain
  the original exact Git routes. Fresh Git boundaries bypass this observation.
- `nextsteps` inspects only the prospective primary draft and, when needed, runs one literal,
  path-scoped status query. Supporting documents remain part of the full publication/review
  checks; an incomplete supporting document still refuses publication.
- An explicitly bound composer acquires the Story lease before loading accepted composition
  context. Entry plus composition now loads full Story context twice rather than three times:
  once for entry and once freshly inside the lease. No mutable pre-lease context is trusted.
- Phase composition has a dedicated provider-free module. Actual installed chunk ownership
  keeps bound entry, composition and nextsteps out of compatibility/model-dispatch bundles.
  Optional release installers and unrelated World Model commands load only when needed.
- `--timings` reports bootstrap and V8 compile-cache flush separately on stderr. Ordinary
  stdout and the non-timed exit path are unchanged. Timing spans can be inclusive; do not add
  all spans together or attribute every unreported millisecond to Git.

Existing deployment-file, CLI closure, hook and VS Code bundle ceilings were not raised. The
existing safe runtime-prewarm policy was not broadened to model-dispatch chunks. Mutable
worktree observations last for one read operation, not the advisory 30-minute cache interval.

## Measurement protocol

`scripts/phase-next-paired-benchmark.mjs` runs four alternating A/B and B/A pairs, reporting the
upper observed median and all raw samples. Both frozen revisions build with their **own**
builder and chunk ownership. Earlier pilot runs that applied the candidate builder to both
revisions were discarded, as were runs whose source identity changed during measurement.

All requests use installed bundles and a verified developer/Story/phase binding. Composed
requests must deliver admitted context; a refusal is not counted as a speedup. Legacy fixtures
have 20 application files. Pinned and amended fixtures have 1,000 files, 50 additional history
commits and eight supporting artifacts.

- Cold: fresh Node process, empty private V8 cache and a fresh local clone without provenance
  receipts. This is process/cache cold, **not** an OS cold boot; filesystem page cache is not flushed.
- Warm: an immediate new Node process against the same code/provenance caches, not an IPC worker.
- Prewarmed first: an independent fresh clone and V8 cache, prepared with `--warm-runtime`,
  without a prior request/provenance receipt. Preparation is measured separately, not free work.
- Persistent low-level Git fact storage is off; accepted-provenance receipts remain enabled.
  Measured requests make no network or model calls. Fixture creation, building and local cloning
  are outside request timing. File counters cover instrumented configuration/catalog sources,
  not every filesystem operation.

These are synthetic command measurements, not complete Story or native Copilot/LLM timings.
Hosted Windows results do not predict corporate antivirus, network-drive or OneDrive overhead.
Four pairs provide directional evidence, not universal latency guarantees.

## This Mac

Native arm64 macOS, Node 22.14.0. Times are before → after, milliseconds.

| Profile | Request | Cold | Warm new process | Prewarmed first |
| --- | --- | ---: | ---: | ---: |
| Legacy | nextsteps | 329 → 261 | 190 → 166 | 239 → 168 |
| Legacy | phase entry | 432 → 326 | 291 → 232 | 342 → 234 |
| Legacy | composed entry | 683 → 552 | 391 → 287 | 593 → 463 |
| Pinned | nextsteps | 427 → 326 | 204 → 164 | 342 → 236 |
| Pinned | phase entry | 569 → 428 | 364 → 277 | 484 → 335 |
| Pinned | composed entry | 855 → 680 | 509 → 342 | 761 → 590 |
| Amended | nextsteps | 522 → 448 | 200 → 163 | 431 → 356 |
| Amended | phase entry | 714 → 582 | 502 → 416 | 627 → 519 |
| Amended | composed entry | 1,070 → 905 | 680 → 507 | 948 → 776 |

Cold reductions range from 14.1% to 24.7%; warm new-process reductions range from 12.7% to
32.8%. Candidate runtime preparation costs 174–183 ms across these cases. It should happen
ahead of a request: charging preparation to the foreground does not make it free.

Pinned composed entry illustrates the separate costs: cold process time falls from 855 to
680 ms; full Story context loads fall from three to two. The candidate explicitly measures
29 ms of compile-cache flush on this first composed request and zero on the immediate repeat.
This is one measured component, not an explanation for all remaining startup time.

## Native hosted qualification

Both benchmark jobs in native run `39493732283` completed successfully with clean frozen
sources and admitted context in every row. The runtime is identical to the development Mac
comparison. Times below are before → after, milliseconds.

### Hosted macOS

Native arm64, Node 22.23.2.

| Profile | Request | Cold | Warm new process | Prewarmed first |
| --- | --- | ---: | ---: | ---: |
| Legacy | nextsteps | 713 → 496 | 424 → 330 | 499 → 361 |
| Legacy | phase entry | 804 → 642 | 586 → 494 | 668 → 474 |
| Legacy | composed entry | 1,419 → 1,102 | 827 → 608 | 1,214 → 947 |
| Pinned | nextsteps | 828 → 661 | 413 → 356 | 793 → 461 |
| Pinned | phase entry | 1,061 → 803 | 690 → 551 | 965 → 665 |
| Pinned | composed entry | 1,656 → 1,329 | 945 → 645 | 1,351 → 1,185 |
| Amended | nextsteps | 1,034 → 770 | 380 → 290 | 856 → 611 |
| Amended | phase entry | 1,277 → 1,008 | 892 → 748 | 1,057 → 856 |
| Amended | composed entry | 1,829 → 1,463 | 1,169 → 841 | 1,601 → 1,295 |

Cold reductions range from 19.8% to 30.4%; warm new-process reductions range from 13.8% to
31.8%. Candidate runtime preparation costs 298–378 ms.

### Windows

Native x64, Node 22.23.3; checkout conversion is enabled.

| Profile | Request | Cold | Warm new process | Prewarmed first |
| --- | --- | ---: | ---: | ---: |
| Legacy | nextsteps | 1,225 → 987 | 779 → 710 | 907 → 697 |
| Legacy | phase entry | 1,979 → 1,455 | 1,537 → 1,175 | 1,681 → 1,181 |
| Legacy | composed entry | 4,124 → 3,525 | 2,189 → 1,464 | 3,788 → 3,093 |
| Pinned | nextsteps | 1,939 → 1,759 | 968 → 720 | 1,654 → 1,248 |
| Pinned | phase entry | 2,993 → 2,170 | 1,975 → 1,485 | 2,720 → 1,935 |
| Pinned | composed entry | 6,621 → 5,712 | 2,614 → 1,867 | 6,552 → 5,389 |
| Amended | nextsteps | 2,812 → 2,374 | 998 → 730 | 2,483 → 2,067 |
| Amended | phase entry | 4,264 → 3,446 | 3,177 → 2,615 | 3,991 → 3,179 |
| Amended | composed entry | 8,261 → 7,603 | 4,237 → 3,054 | 7,588 → 5,121 |

Cold reductions range from 8.0% to 27.5%; warm new-process reductions range from 8.7% to
33.1%. Candidate runtime preparation costs 541–702 ms. Not every path improves equally:
pinned nextsteps saves 9.3% cold, and amended composition saves 8.0% cold despite removing
Git calls. Their remaining costs are visible rather than assumed away.

### Remaining first-request cost

The candidate's timed Windows composed entries report the following separate upper medians.
They are components of the same request; medians and nested spans are not additive.

| Profile | Cold wall time | Terminal command timing | Explicit V8 cache flush | Warm new-process wall time |
| --- | ---: | ---: | ---: | ---: |
| Legacy | 3,525 ms | 2,318 ms | 1,121 ms | 1,464 ms |
| Pinned | 5,712 ms | 3,233 ms | 2,443 ms | 1,867 ms |
| Amended | 7,603 ms | 4,735 ms | 2,783 ms | 3,054 ms |

This identifies cache persistence as a substantial measured cold component, not just module
loading or Git. Definition-only prewarming does not eliminate it: pinned composed entry still
reports a 2,339 ms cache flush after preparation. Do not assume a compile-cache write is a DNS,
network, LLM or repository-history delay. Cache-flush placement/serialization and the remaining
accepted-provenance/recovery reads are candidates for further controlled optimization; this
change does not disable caching or defer mutation checks to obtain smaller numbers.

### Ordinary-request control

Native run `39497865584` successfully repeated the pinned cases without `--timings`, using two
alternating pairs and the same clean baseline. Candidate `5669ab87b350c53928004a7589cacf34ac52a4c0`
adds only the benchmark's ordinary-request switch and the test-only corrections to the measured
runtime. No production runtime changed. Uncollected Git counters are `null`, never invented zeros.

| Host | Pinned request | Cold | Warm new process | Prewarmed first |
| --- | --- | ---: | ---: | ---: |
| macOS | nextsteps | 1,027 → 662 | 455 → 342 | 869 → 618 |
| macOS | phase entry | 1,412 → 843 | 828 → 590 | 1,186 → 729 |
| macOS | composed entry | 1,831 → 1,419 | 979 → 758 | 1,418 → 1,040 |
| Windows | nextsteps | 1,072 → 851 | 531 → 422 | 893 → 734 |
| Windows | phase entry | 1,695 → 1,354 | 1,182 → 808 | 1,482 → 1,051 |
| Windows | composed entry | 2,861 → 2,414 | 1,653 → 1,015 | 2,816 → 2,163 |

Windows ordinary controls improve 15.6–20.7% cold and 20.6–38.6% warm; the macOS control also
improves in every row. This confirms the direction for ordinary invocations, not a precise
instrumentation-overhead estimate. The controls ran on different hosted machines from the main
four-pair experiment, so do not subtract their timings across jobs to infer that cost. Two pairs
are a cross-check, not a substitute for the primary sample set. All results exclude Copilot/LLM time.

Use `--request-timings=false` to reproduce this control with the same harness.

## Accepted qualification record

The accepted native selections cover 350 distinct targeted test cases on **each** host, with
zero failed, cancelled, skipped or todo cases in the accepted runs:

| Selection | Cases per host | Native run | Revision |
| --- | ---: | --- | --- |
| Snapshot, context, worker, provenance, parser, product-requirement and bundle integrity | 148 | `39494698111` | `326a8da2` |
| Unchanged phase-entry, fingerprint and preparation/evidence recovery cases | 106 | `39493732283` | `00f1f814` |
| Final lifecycle/report-restoration cases, including the strengthened symlink test | 96 | `39496834255` | `784c8239` |

The first full phase selection passed all 202 cases on macOS. Its Windows result was not accepted
as a complete qualification: two filesystem cases used invalid Win32 filenames, and one case
unconditionally skipped Windows. The affected 96-case selection was rerun on both hosts after
the test-only corrections; the other 106 passing cases and runtime code were unchanged. The
strict no-skip reporter was retained. The final integrity run also passed all 2,916 product checks,
VS Code typechecking and the VS Code build on both hosts.

The ordinary-control flag changes one existing benchmark child argv, not its executable or
process count. Its reviewed Git/process audit fingerprint was updated without adding a bypass,
registering a new owner, or raising an execution budget. The runtime changes precede all of
these test/harness-only follow-ups. Native run `39499064390` revalidated the final audit metadata
at `c1d3f20b` on both hosts; all 2,916 product checks passed again.

Qualification uses a disposable CI-only branch, never a production hosted workflow. Primary
benchmark artifacts from `39493732283` and ordinary controls from `39497865584` retain the raw
JSON samples and logs. This is a targeted performance/safety qualification, not a full repository
test-suite or 1.0 release certification.

## Safety and qualification boundaries

Regressions cover external edits, fresh-boundary bypass, an alternate index, lagging Story
indexes, renames and quoted paths, exact draft names under host pathspec settings, supporting
document checks, and composition after an advisory memo becomes invalid. A bundled ESM
module-roster test exercises bound entry, composed entry and nextsteps and rejects either
compatibility or model-dispatch loading.

The native Git whitespace test uses supported space-containing names on Windows, since Win32
cannot create tab/newline filenames. Raw-byte parser cases still test control bytes on every
host; POSIX also round-trips them through the filesystem. No platform skip was introduced.
Lifecycle report fixtures likewise use bracketed rather than double-quoted filenames on
Windows. The report-restoration symlink test no longer skips Windows: it requires a proof
marker that the runner really created the symlink, then verifies restoration and the external
sentinel bytes. A host lacking that capability fails qualification rather than silently skipping it.

The benchmark also records candidate parent-owned IPC nextsteps first/repeat/prepared requests.
Those are not a native Copilot shell transport and are not included in the command gains above.
No actual Story, human approval, installed CLI or editor configuration is changed by these fixtures.

To reproduce, install locked dependencies in both frozen checkouts, then run from the candidate:

```sh
node scripts/phase-next-paired-benchmark.mjs \
  --baseline-engine=/absolute/path/to/baseline \
  --samples=4 --prewarmed=true --output=/absolute/path/to/results.json
```

The report records both clean commit identities, platform, Node version, all samples, physical
Git call counts, response bytes and measured stages. Source changes during measurement refuse
the report. Compare the same successful binding and temperature on the same host.
