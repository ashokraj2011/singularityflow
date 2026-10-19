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
Native platform results follow; absolute times are host-specific.

## Measured Mac results

These are installed-bundle review-retention publications, not phase-test or network-push timings.
The candidate path is `1078bf60`, compared with `b440b0a6`. The later `e130be84` change extends
the no-REV absence fast path to phase-publication preflight (which this specification-review
corpus does not invoke) and corrects the standalone benchmark's scope label.
Later platform corrections through `5c2de7ac` canonicalize native Node test-event file aliases
before exact identity checks and fix platform-specific test-fixture setup. These do not change
this measured specification-review retention path.

| Host / corpus | Pairs per temperature | Cold before → after ms | Warm before → after ms |
| --- | ---: | ---: | ---: |
| This Mac, larger | 4 | 2,231.5 → 2,178 | 1,919.5 → 1,887.5 |
| Hosted macOS, small | 2 | 849.5 → 825.5 | 778 → 704.5 |
| Hosted macOS, larger | 4 | 887 → 893.5 | 777.5 → 779.5 |

Local Node was 22.14.0; hosted runs used Node 22.23.3. The larger Mac case is effectively flat,
not a substantial speedup. A separate two-pair local small smoke overlapped exploratory testing
and is not used for a performance claim (cold 1,947 → 1,803.5 ms; warm 1,622 → 1,720 ms).
Do not combine different hosts' absolute timings into one speedup figure.

The final dedicated writer's static installed closure is 5,279,726 bytes, versus 7,161,598 bytes for
the baseline chunk containing the former Story store (about 26% less). The complete deployment
has 21 coarse files versus 20. Reader/catalog parse budgets and the partial-deployment fallback
remain enforced. A smaller import graph alone does not imply the same elapsed-time saving.

Hosted Mac measurement run `39201529449` checked one fresh review binding and three independent
input loads in every measured before/after publication. Optimized small runs used 100 Git
processes cold / 89 warm, and larger runs 106 cold / 95 warm. Each retained one immutable-tree
read hit; renamed/copied-resource diffs and the mutable ref checks still executed independently.

## Measured Windows results

Native Windows measurement job `117895342257` in run `39201529449` completed successfully on
Node 22.23.3, with independent runners for tests and timing. These are medians, not guarantees
for an office laptop, corporate antivirus/proxy setup or cloud-backed checkout.

| Corpus | Pairs per temperature | Cold before → after ms | Warm before → after ms |
| --- | ---: | ---: | ---: |
| Small | 2 | 5,670 → 5,644.5 | 5,371 → 5,126 |
| Larger | 4 | 6,900.5 → 6,331 | 6,745 → 6,346 |

The larger profile improved about 8% cold and 6% warm; small cold publication was essentially
flat, and the small warm smoke improved about 5%. Cold and warm use different fixtures and
cache preparation, so a single cold/warm ordering is not a statistical latency promise.

Git processes decreased by three in each case: small 103 → 100 cold / 92 → 89 warm, and larger
109 → 106 cold / 98 → 95 warm. Every observation retained exactly one fresh binding check and
three independent input loads. This is a modest kernel improvement, not a removal of the
publication transaction's remaining local Git/process and filesystem work.

In the larger optimized cold case, the new spans measured about 26 ms for the narrow writer load,
306 ms for recovery capture and 14 ms for journal creation. Admission was about 659 ms, Candidate
processing 586 ms and commit 578 ms; review inputs totalled about 883 ms. These spans overlap
other measurements and are not an additive decomposition. Cached mutable authorization or a
delayed/background success acknowledgement is not used to achieve these results.

## Windows correctness discovered during qualification

The first complete native regression pass exposed four failures, rather than being reported as
green. Hand-authored historical/corrupt journal fixtures now apply and verify actual Windows
private ACLs before exercising record validation; runtime ACL enforcement is unchanged. The
POSIX non-executable-hook integration is explicitly platform-specific, while synthetic ignored-hook
classification and real executable-hook enforcement still run on Windows.

The other failure exposed a real native Node reporter issue: a Windows temporary/cwd path may use
an 8.3 alias while test events use the long pathname. Diagnostic output confirmed a passing test
was rejected as outside the root. Both sides now use native filesystem real paths before containment
and exact test-file identity checks; the JavaScript symlink walker alone preserves DOS short names.
Resolution is shared once per reported file, not repeated for every test case. Missing and
outside-repository files remain incomplete and cannot earn exact test credit. A directory-alias
and native-long-path regression runs on both platforms. Malformed identities raise a structured
result parse error so the existing bounded, redacted command diagnostics are retained, with bounded
field-level reason codes instead of a generic error that discarded the useful output.

## Reviewed boundary moves

The frozen Git inventory records the unchanged history/show sites moving from `state.mjs` into
`story-policy-anchor.mjs`, and the existing Candidate executor moving behind the closed immutable
read wrapper. Benchmark launch sites remain bounded Node processes against disposable fixtures;
the additional `rev-parse HEAD` assertion proves that measured publication really committed.
No new registered process owner or arbitrary Git capability is granted. Lifecycle vocabulary
forwarding registrations follow the exact Story function/class moves; Initiative's existing
wrapper and runtime event validation remain unchanged.
