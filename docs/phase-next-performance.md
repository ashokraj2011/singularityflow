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
