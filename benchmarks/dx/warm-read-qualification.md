# Private warm read worker qualification

Run `node scripts/warm-read-benchmark.mjs --samples=5 --files=1000 --branches=20`.
The checked-in JSON records a macOS arm64 / Node 25.5.0 local run, not a native Windows or
Copilot conversation qualification. The benchmark creates a stamped engine package and its CLI
and read-worker bundles, uses only a local bare Git remote, invokes no model, and removes its
temporary fixture even on failure. Fixture setup/bundling is outside the measured samples.

| Read | Cold CLI median | Warm worker median | Reduction |
| --- | ---: | ---: | ---: |
| Repository snapshot | 226 ms | 67 ms | 70% |
| Core UI snapshot | 394 ms | 176 ms | 55% |
| Status | 183 ms | 4 ms | 98% |
| Next steps | 264 ms | 25 ms | 91% |

First worker reads were 320–457 ms, including startup, and slower than cold CLI medians.
The complete Story intake fixture (stock Chore workflow, including a local bare push) took a
1,924 ms median across five runs. That mutation is not routed through the worker and this is
not evidence that its duration improved. No human approval, application generation or full
Copilot Story run was automated by this benchmark. Native Windows qualification remains open.

## Correctness and fallback coverage

- Closed read vocabulary: selected snapshot slices, plain status and nextsteps; all author,
  reviewer, readiness, repair, publication and mutation forms retain their normal CLI boundary.
- Fresh per-request read/operation/configuration scopes; command-local Git location/object/ref
  caches cleared before and after requests. Code is warm, not mutable authority observations.
- Source and bundled CLI parity (allowing only documented read-time report timestamps), external
  file/state edits, environment changes, commit/content build replacement, malformed IPC, failed
  worker launch, cancellation, explicit invalidation, and retirement after 64 reads.
- Cross-client coalescing, independently cancelled subscribers, repository switching, fresh
  environment scopes, unshared agent packets, and duplicate Store refresh joining. Actual changes
  and new slices still require a coherent follow-up. Existing priority/receipt-isolation tests run.
- Narrow governed-tree and Git/common-directory watchers invalidate read reuse. Writes remain
  outside the read pool and invalidate shared results before/after their normal CLI operation.
- One CLI fallback on unavailable worker, no retry after cancellation; no persisted endpoint,
  shared author/reviewer session or cross-command mutation context.

## Packaging budget

The worker transport remains in the selected CLI package rather than entering the extension's
static module graph. The new client-sharing/adapter code adds about 2.7 KiB to the lazy panels
bundle (module count unchanged, 249). Its byte ceiling moves from 3,030,000 to 3,033,000; all other
bundle ceilings remain unchanged. This small explicit allowance does not admit the engine into
the extension bundle. The read-worker entry ships in the stamped CLI bundle manifest.
