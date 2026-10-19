# Publication context and first-write qualification

Baseline: `b440b0a6` from main. The implementation keeps the same locked lifecycle transaction,
recovery journal, secret/environment admission, Candidate verifier and final compare-and-swap.
No application tests, human approval, independent review or remote push is skipped by this work.

## Changes

- A focused Story publication gateway replaces the source-review route's eager legacy state-store
  import. Canonical persistence, operational-policy projections and workflow validation are shared
  leaves; their old exports remain available. Generation, approval, strict validation, accepted
  amendments and nontrivial recovery still reach their original owners when required.
- One async-local context lasts only for a locked publication. It shares bounded copies of exact
  literal tree-entry bytes keyed by full object IDs, repository and environment. It never caches
  live files, rename detection, refs, HEAD, identity or a permission to mutate. Frames are isolated
  between concurrent/nested transactions and discarded on every completion or failure.
- Paired commit/tree metadata reads use one Git process with strict complete-output validation.
  Retained refs remain fresh, and verification still independently reconstructs resources. The
  admission index, verifier index and final live restaging remain separate.
- The no-REV code-phase check proves protected pointer/journal absence under the Story lease
  without constructing a revision producer and hashing the installed runtime. Present journals
  retain full producer/chain validation. Unsafe storage and malformed records are not absence.
- A dedicated installed writer chunk adds one coarse deployment file (21 versus 20); existing
  reader/catalog/session budgets remain separate. Runtime preparation includes that definitions-only
  chunk, never a publication handler or cached authorization.
- Timings now separate writer loading, recovery capture and journal creation from the existing
  state-write, admission, Candidate, commit and push spans.

## Reproduce

Build both baseline and candidate CLI bundles with the same Node version. From the candidate:

```sh
node scripts/source-review-paired-benchmark.mjs --baseline-engine=/path/to/baseline --runtime=bundle --publication=both --profile=large --samples=4 --output=/path/to/results.json
```

The corpus is a disposable, genuinely published Story. Each measured retention creates a real
local lifecycle commit and checks its retained review identity afterward. No real user Story,
repository remote, approval or application is modified. The larger profile adds 100 history commits
and 16 attachments; small adds neither. Alternating A/B and B/A order reduces sequential host-load
bias. The measured cold command starts with empty private Git-fact and V8 compile caches; preparing
its report uses different setup caches. Warm commands use prior review reads plus explicit installed
runtime preparation. Both still execute fresh binding checks. OS disk caches are not flushed.

Measured retention excludes fixture/report preparation, model reasoning, shell-tool transport,
application tests and network publication. It is not an end-to-end Copilot or phase-test estimate.
Native platform results are recorded after qualification; absolute times are host-specific.

## Reviewed boundary moves

The frozen Git inventory records the unchanged history/show sites moving from `state.mjs` into
`story-policy-anchor.mjs`, and the existing Candidate executor moving behind the closed immutable
read wrapper. Benchmark launch sites remain bounded Node processes against disposable fixtures;
the additional `rev-parse HEAD` assertion proves that measured publication really committed.
No new registered process owner or arbitrary Git capability is granted. Lifecycle vocabulary
forwarding registrations follow the exact Story function/class moves; Initiative's existing
wrapper and runtime event validation remain unchanged.
