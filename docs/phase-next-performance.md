# Bound phase and next-step performance

## Changes

- A bounded Story-local history read supplies immutable first-add/touch observations together.
  Merge and rename/copy histories retain the original exact-path traversal. Missing objects,
  changed/restored records, shallow boundaries and invalid Git output remain errors.
- Immutable tree metadata is acquired once per exact commit/visibility in a verification scope,
  then projected to each requested path. Oversized or unavailable optional inventories fall back
  to the original bounded reader; they never become empty successful trees.
- Accepted snapshots and strict Story loading share rejection-audit verification through the
  existing routine verification cache. Exact raw/normalized inputs have four private slots per
  provenance kind, preventing repeated eviction. Explicit refresh and Git/index/config/object
  changes still invalidate them. The configurable 30-minute default is unchanged.
- Phase entry validates syntax through a narrow leaf and resolves the current binding before
  importing authoring/recovery services. Read-only next guidance imports only the binding owner.
  Constructing a grounding-record path no longer loads source-review/input readers.
- The parent-owned VS Code worker accepts the closed `nextsteps [ID] --for-agent --json` form.
  It uses the canonical binding, pause, guidance and output-presentation owners. Each request
  resets mutable observations. Background preparation loads reset owners before reporting ready.
  Authoring, composition, review, tests, publication and approvals remain outside this worker.
  The VS Code tool-policy gateway retains its original fresh verification path and does not
  embed the CLI batching graph; existing bundle limits are unchanged.
- Composing a skill phase passes the accepted definition into input collection. The prior missing
  handoff was a correctness failure, not a performance result.

No persistent worker endpoint is exposed to arbitrary shell processes. Native Copilot shell
commands still use the CLI; worker results measure SFlow-owned integration requests. No human
approval, application edit, model invocation, remote fetch or Story advancement is benchmarked.

## Reproduction

```sh
node scripts/phase-next-paired-benchmark.mjs --baseline-engine=/absolute/baseline --samples=4 --output=/absolute/results.json
```

Four alternating A/B and B/A pairs use independent local clones and installed bundles. Legacy
fixtures have 20 source files; pinned/amended fixtures have 1,000 files, 50 additional commits and
eight artifacts. Every successful entry must have a real current-phase agent binding; composed
cases must deliver context. Setup, cloning, builds and private session binding are outside timing.

Cold means a fresh Node process, empty private V8 cache and no accepted-provenance receipts.
Warm means a new Node process with those caches populated; the OS page cache is not flushed.
The low-level cross-process Git fact store is disabled to isolate these owners. Timings retain
each sample, Git counters, coarse stages and named spans. Nested spans are not additive.
Summaries use the upper observed median, not an interpolated average or a confidence bound.

Worker-start, repeated-worker and definition-prewarmed requests are reported separately. The
prewarmed case uses an independent fresh clone and V8 cache, not the repeated request's receipts.
Worker preparation does no repository reads; its measured cost is reported separately and is
excluded only from the explicitly prewarmed request row. Raw agent JSON retains complete binding
fields for measurement; default bounded presentation is covered by the worker parity regressions.
The baseline's amended skill composition refuses with the missing-definition error; that row has
no percentage gain. Native Windows results require `runtime.platform=win32`.

Qualification targets portable entry, cache, worker, snapshot/amendment, test-command epoch and
published-contract regressions. It is not a full-suite or 1.0 release qualification. The unmodified
POSIX terminal reattestation ceremony is outside the Windows performance selection; release skip
policy and human-terminal authorization are unchanged. Native checkout conversion is enabled;
fixture authority files retain exact bytes and recovery assertions compare Git-rendered bytes.

## Native results

Baseline: `4786580ac14b86b646990a44cf0e8c377d6b3097`. Final runtime candidate:
`148e4394a6baa7bba5a7f99645c6da22fb203c8d`. Both measured source checkouts were clean;
the harness records these identities before setup and rejects source changes before completion.
The following tables report milliseconds, baseline → candidate. Positive reductions mean faster;
negative reductions mean slower. Four pairs are a small sample, not a statistical guarantee.

### macOS

Native hosted ARM64, Node 22.23.2, qualification run `39456556959`:

| Story | Request | Cold ms | Reduction % | Warm ms | Reduction % | Cold Git spawns | Warm Git spawns |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Legacy | nextsteps | 478.84 → 495.42 | -3.5 | 277.04 → 274.61 | 0.9 | 6 → 6 | 6 → 6 |
| Legacy | phase entry | 641.61 → 618.78 | 3.6 | 443.64 → 436.25 | 1.7 | 26 → 26 | 26 → 26 |
| Legacy | composed entry | 1023.30 → 962.51 | 5.9 | 593.97 → 591.87 | 0.4 | 32 → 32 | 36 → 36 |
| Pinned | nextsteps | 591.57 → 604.11 | -2.1 | 286.92 → 280.86 | 2.1 | 22 → 21 | 9 → 9 |
| Pinned | phase entry | 707.75 → 757.58 | -7.0 | 479.92 → 471.26 | 1.8 | 38 → 37 | 27 → 27 |
| Pinned | composed entry | 1138.81 → 1132.42 | 0.6 | 662.94 → 662.12 | 0.1 | 44 → 43 | 37 → 37 |
| Amended | nextsteps | 800.24 → 676.54 | 15.5 | 340.37 → 262.17 | 23.0 | 59 → 39 | 20 → 10 |
| Amended | phase entry | 976.59 → 897.41 | 8.1 | 795.08 → 676.18 | 15.0 | 82 → 61 | 82 → 55 |
| Amended | composed entry | refused → 1286.23 | N/A | refused → 828.73 | N/A | 94 → 67 | 85 → 65 |

The amended composed baseline fails with `Skill phase 'threat-model' inputs require the accepted
Story definition.` The candidate completes with admitted context. Refusal latency is not useful
work, so neither it nor the reduced Git count establishes a speedup for that row.

An independent run on the development Mac (ARM64, Node 22.14.0), with the same final runtime and
four amended-Story pairs, measured nextsteps at 609.20 → 535.06 ms cold (12.2%) and
258.87 → 197.00 ms warm (23.9%); phase entry at 762.70 → 701.46 ms cold (8.0%) and
619.37 → 490.87 ms warm (20.7%). This replicates the amended-Story improvement, not a universal
gain across ordinary Stories.

### Windows

Native hosted x64, Node 22.23.3, qualification run `39456556959`:

| Story | Request | Cold ms | Reduction % | Warm ms | Reduction % | Cold Git spawns | Warm Git spawns |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Legacy | nextsteps | 1168.65 → 1165.74 | 0.2 | 760.11 → 765.14 | -0.7 | 6 → 6 | 6 → 6 |
| Legacy | phase entry | 1924.00 → 1893.91 | 1.6 | 1519.05 → 1507.33 | 0.8 | 26 → 26 | 26 → 26 |
| Legacy | composed entry | 4454.90 → 3927.55 | 11.8 | 2265.56 → 2156.35 | 4.8 | 32 → 32 | 36 → 36 |
| Pinned | nextsteps | 1900.02 → 1880.78 | 1.0 | 970.68 → 970.00 | 0.1 | 22 → 21 | 9 → 9 |
| Pinned | phase entry | 2886.44 → 2890.66 | -0.1 | 2100.93 → 2084.34 | 0.8 | 38 → 37 | 27 → 27 |
| Pinned | composed entry | 4860.72 → 4841.91 | 0.4 | 3034.31 → 3011.53 | 0.8 | 44 → 43 | 37 → 37 |
| Amended | nextsteps | 3168.75 → 2558.93 | 19.2 | 1355.06 → 892.06 | 34.2 | 59 → 39 | 20 → 10 |
| Amended | phase entry | 4727.82 → 4374.90 | 7.5 | 4292.85 → 3440.58 | 19.9 | 82 → 61 | 82 → 55 |
| Amended | composed entry | refused → 5961.84 | N/A | refused → 3872.58 | N/A | 94 → 67 | 85 → 65 |

The legacy composed cold gain was only 1.6% in the earlier native run, versus 11.8% here, with
unchanged Git counts; do not treat that noisy row as a repeatable 11.8% improvement. Amended
nextsteps and phase-entry improvements reproduced in both native runs and the development Mac.

### Owned nextsteps worker

Candidate-only observed medians, rounded to whole milliseconds. These are separate transport
states, not an A/B speedup claim. "Prepared first" still starts with cold repository provenance.

| Host | Story | Worker start + first request | Repeated worker request | Prepared first request | Separate background preparation |
| --- | --- | ---: | ---: | ---: | ---: |
| macOS | Legacy | 467 | 79 | 128 | 333 |
| macOS | Pinned | 542 | 83 | 219 | 316 |
| macOS | Amended | 678 | 80 | 350 | 316 |
| Windows | Legacy | 1098 | 267 | 423 | 670 |
| Windows | Pinned | 1741 | 468 | 1066 | 669 |
| Windows | Amended | 2642 | 534 | 1946 | 688 |

Prewarming shifts definition startup before the user's request only when background preparation
has finished. Adding preparation and first-request time gives approximately the original cold
worker cost; hiding preparation is not an end-to-end saving. Repeated worker requests benefit
from loaded modules but still reset mutable state and observe the current session/repository.

### Interpretation

Legacy and ordinary pinned CLI paths remain mostly flat; some cold rows are slower. The clear
improvement is amended provenance: nextsteps removes 20 cold / 10 warm Git spawns, and phase entry
removes 21 cold / 27 warm spawns in this corpus. Binding-first entry avoids the full authoring
closure for missing/paused bindings; a ready authoring request still needs its original services.
No readiness, hash, ancestry, source-review, policy or mutation gate was removed to obtain savings.

Optional combined inventories never hydrate a remote object. A fresh final-binding scope bypasses
both an enclosing tree inventory and a history batch, returning to the original exact Git owners.

## Qualification record

Native run `39454606512` tested runtime `307471f5` on macOS and Windows: 45 phase-entry/recovery
tests plus 173 integrity regressions on each host (218 passed per host; zero failed, cancelled,
skipped or todo). Both hosts also passed product validation, VS Code typechecking/build and the
complete paired benchmark. The final runtime then added two narrow hardening changes:
`GIT_NO_LAZY_FETCH=1` for optional history acquisition and explicit fresh-scope bypass of enclosing
provenance batches. Run `39456556959` rechecked these changes at `148e4394` with 56 targeted
regressions on each host, all passing with zero skipped tests; product validation, typecheck and
build also passed on both hosts. The measurements above use this final runtime, not an earlier
development candidate. Subsequent changes to this report are documentation only.

The initial qualification exposed fixture assumptions about LF-only recovery bytes, conversion
of immutable template bytes and delayed Windows file-handle release. Those were corrected using
Git-filtered expected bytes, fixture attributes and bounded cleanup retries. Production recovery
and review authorization were not weakened. Existing lifecycle and VS Code byte/module budgets
were retained and passed; no ceiling was raised to accommodate the implementation.
