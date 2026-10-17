# Isolated intake: bounded configuration reuse and background checkout

## Changes

Pin discovery reads only the workflow's custom-root hint and tracked canonical Story records.
It no longer parses every agent/template to discover a path. A hint grants no authority: secure
containment, canonical identity and the exact configuration pin are still checked independently.

The publication-time capability resolver reuses the owner-verified compiled configuration through
a bounded materialized read scope. Each consumer gets a separate copy. The full materialized
asset inventory and exact bytes are rechecked before reuse, and every definition load still checks
live output roots and environment-local exclusions. Nothing survives the bounded consumer; a
changed snapshot, extra asset, changed file or unsafe output root still refuses reuse. Enrollment's
changed configuration and ordinary reads retain independent validation.

Git observes both staging-ref spellings in one bounded read. Missing-base discovery batches all
selected remote-tracking refs and runs only when a base really is missing, not on every explicit
base launch. Prepared-checkout verification reads HEAD and branch together. None of these
observations caches a mutable ref across a write or replaces publication's fresh authority checks.

## Background preparation

After a passing exact-request intake preview issues a machine-local receipt, VS Code can create
the full application checkout while the person finishes intake. It uses the same installed CLI
and a client pinned to the launch repository, even if the window later changes repositories.
The optional coordinator is loaded from the existing lazy runtime, not the activation graph.

`story prepare-worktree --work-id ID ... --intake-receipt RECEIPT` claims and validates that exact request,
checks its local base/remote bindings, creates only the ordinary managed staging worktree, then
releases the receipt. It does not create a workflow, enroll an identity, run SFlow tests, or publish.
It returns the exact base and whether it created the checkout. A receipt is still not authority.
The optimization is disabled with `SINGULARITY_FLOW_INTAKE_WORKTREE_PREPARATION=off`.
Preparation and cleanup use dedicated `story prepare-worktree` and `story discard-worktree` verbs;
older engines refuse these unknown operations instead of interpreting preparation as normal Start.

Start waits for an in-flight preparation rather than killing Git. Its normal authority, base,
readiness, dirty-tree, Candidate and exact-tip publication checks all remain required. If the base
moved, only an unchanged, clean, unpublished staging checkout may be replaced. A reused baseline
checkout is never claimed for panel cancellation cleanup. Explicit baseline execution retains its
existing separate path and does not use background preparation.

Selection changes and panel disposal settle native work and request exact cleanup of owned
preparations. Cleanup verifies the managed namespace, canonical common directory, staging branch,
exact base and all tracked, untracked and ignored changes. It never uses force removal or resets
files. Ref deletion uses an exact old-value comparison and does not follow a symbolic ref. Dirty,
changed, published or unverifiable work is retained. Process termination may leave a registered
staging checkout for normal recovery; this is not a broad temporary-folder garbage collector.

## Qualification protocol

Cold creation and background-prepared creation are separate comparisons. The latter gives both
variants the same exact-request preview, then prepares only the candidate's worktree. Reports retain
preview time, preparation time, click-to-ready time and their combined wall time separately.
Background preparation shifts work off the click path; it is not claimed to reduce total work.

Native qualification exposed a Windows host compatibility defect: the system Windows PowerShell
ACL helper inherited PowerShell 7 module locations, so `Get-Acl` could not autoload. The child now
uses only its own `$PSHOME/Modules`; ACL requirements and unsafe-store fallback are unchanged.
Native tests include an incompatible inherited module path. In the prepared Windows comparison,
the old control may explicitly report a storage-declined receipt and use full Start validation.
The candidate must issue a real receipt and actually prepare. This measures the combined host
compatibility correction and preparation path, not checkout alone or a fabricated receipt.

```sh
node scripts/story-creation-benchmark.mjs --mode=isolated --fresh=true --configuration=approved --samples=3 --files=10000 --control-ref=697a8738fd58c47503463444c38dd55d89ad6988 --out=cold.json
node scripts/story-creation-benchmark.mjs --mode=isolated --fresh=true --configuration=approved --samples=3 --files=10000 --prepare-worktree=candidate --control-ref=697a8738fd58c47503463444c38dd55d89ad6988 --out=prepared.json
```

Candidate-only runtime modules are
removed from the disposable control engine during its build and restored before candidate runs.
Every sample asserts the exact published remote tip. Native Windows qualification uses a temporary
CI-only branch; its hosted workflow must never be merged into production. Local bare remotes do
not measure corporate network latency, antivirus policy or native VS Code paint time.

## Retained results (17 October 2026)

The control is `697a8738fd58c47503463444c38dd55d89ad6988`. The final CLI implementation is
`b5d4a01f4c35ef0c67db4f247506a2c2ebaf83c4`; subsequent changes before qualification affect
VS Code integration and portable test assertions, not `src/`, `scripts/` or the dependency lock.
The exact sources and CI runs are recorded in
`benchmarks/story-creation/intake-preparation-qualification.json` alongside the raw reports.

| Native host / fresh 10,000-file fixture | Pairs | Control Start | Candidate Start | Control combined time | Candidate combined time |
| --- | ---: | ---: | ---: | ---: | ---: |
| Windows, cold | 1 | 14,484 ms | 14,213 ms | 14,484 ms | 14,213 ms |
| Windows, cold (separate runner; median) | 3 | 21,467 ms | 20,821 ms | 21,467 ms | 20,821 ms |
| Windows, background-prepared | 1 | 14,438 ms | 9,871 ms | 16,722 ms | 21,155 ms |
| macOS, background-prepared (median) | 3 | 3,271 ms | 2,916 ms | 4,316 ms | 4,530 ms |

The final Windows measurements are single matched observations, **not** a latency distribution
or a guaranteed percentage. Prepared Start was 31.6% shorter in this observation, while cold
Start was essentially flat (1.9% in the one-pair job, 3.0% in the three-pair job). Those jobs ran
on separate shared runners; do not pool them or treat their absolute times as interchangeable.
The Windows candidate spent 6,972 ms in preview and 4,312 ms
in preparation before Start. Its combined time increased by 4,433 ms. The old control explicitly
declined its receipt because of the Windows ACL host defect and used ordinary full validation;
the candidate issued and used a real receipt. These results measure that correction plus
preparation, not preparation in isolation. macOS also had a 5,304-ms candidate outlier.

Full definition loads fell from five to three in the Windows cold sample; prepared Start used
four versus five, with two exact-byte-fenced materialized reuses versus one. Git subprocesses
were 167 versus 168 cold and 164 versus 168 prepared. These are bounded reductions, not removal
of publication checks. No mutable authority/ref result is carried across publication writes.

### Remaining click-path costs

In the prepared Windows sample, checkout itself moved from 4,141 ms at Start to 4,312 ms before
Start; checking/reusing the prepared checkout took 124 ms. The remaining Start still includes
about 3,713 ms for publication (including candidate validation, commit and exact-tip push),
1,537 ms for enrollment, 897 ms for authority selection and 248 ms for materialization. These
are nested/instrumented spans, not independent components to add into a second total. Its Git
service time was 7,002 ms and 164 subprocesses remain: further measured work should target
additional redundant read batches and enrollment rather than making push asynchronous or
removing authority checks.

Background preparation is most useful when the person spends time completing intake after the
preview. An immediate Start waits for unfinished preparation, so this is not a promise of a
faster first request or less total CPU/filesystem work. The kill switch provides an exact control.

### Qualification boundaries

Native Windows host qualification passed 42 receipt/ACL/command/catalog/coordinator/bundle tests,
three end-to-end preparation tests and TypeScript checking in a separate all-green recheck.
Ten focused legacy/preparation regression cases also passed in a second all-green Windows run,
including receipt fallback/release, custom remotes, external capability authority and changed-file retention.
The two final Windows performance jobs also passed and verified exact remote tips, although
their combined CI run initially failed on three test portability assumptions; that run is not
represented as wholly green. Installed-bundle smoke, local isolation/publication tests, the
repository check and unchanged VS Code bundle ceilings were also checked on macOS.
The final local isolation/publication/configuration/coordinator group passed 109 tests without skips.

Earlier broad Windows qualification exposed long **legacy fixture** paths exceeding Git's default
MAX_PATH limit and an assertion that mistook the durable private-store integrity key for a leaked
receipt claim. The assertion now distinguishes that key without allowing claim files. Focused
legacy-case rechecks use a shorter temporary root, not changed Git or application policy. Long
production checkout paths and enterprise filesystem policy are not qualified by this fixture.
Earlier multi-pair performance runs also encountered fixture setup `git add` timeouts; no partial
or failed setup run is included in the final timing table. Larger Windows distributions and actual
office-laptop/VS Code end-to-end traces remain necessary for deployment-wide latency claims.
