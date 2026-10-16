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

`start ID --prepare-only ... --intake-receipt RECEIPT` claims and validates that exact request,
checks its local base/remote bindings, creates only the ordinary managed staging worktree, then
releases the receipt. It does not create a workflow, enroll an identity, run SFlow tests, or publish.
It returns the exact base and whether it created the checkout. A receipt is still not authority.
The optimization is disabled with `SINGULARITY_FLOW_INTAKE_WORKTREE_PREPARATION=off`.

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

```sh
node scripts/story-creation-benchmark.mjs --mode=isolated --fresh=true --configuration=approved --samples=3 --files=10000 --control-ref=697a8738fd58c47503463444c38dd55d89ad6988 --out=cold.json
node scripts/story-creation-benchmark.mjs --mode=isolated --fresh=true --configuration=approved --samples=3 --files=10000 --prepare-worktree=candidate --control-ref=697a8738fd58c47503463444c38dd55d89ad6988 --out=prepared.json
```

Candidate-only runtime modules are
removed from the disposable control engine during its build and restored before candidate runs.
Every sample asserts the exact published remote tip. Native Windows qualification uses a temporary
CI-only branch; its hosted workflow must never be merged into production. Local bare remotes do
not measure corporate network latency, antivirus policy or native VS Code paint time.
