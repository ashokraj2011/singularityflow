# Source review performance

`/sf-review-source` still performs independent semantic review. This optimization changes only
its deterministic Node/Git reads; it does not remove citation checking, source coverage, reviewer
independence, human decisions or the last fresh retention binding check.

## Read model

One operation shares a commit-bound snapshot across context, private staging and validation.
Named source/artifact/clarification files are read in a verified Git object batch, followed by a
batch of the attachments offered to that phase. No application tree, all-branches scan or broad
history walk is added. Each live file still passes regular-file/path confinement, byte/hash and
publication checks. Windows CRLF checkouts keep the existing committed-byte comparison.

Immutable provenance objects are reused through the existing private Git fact cache. Introduction
history still proves exactly one introducing commit; the sidecar and lifecycle projection must
appear together and the event must be absent from the parent. Actor, authority and report hashes
are rechecked. Cache expiry is not approval. Missing objects, shallow/graft/replacement or Git
configuration changes invalidate facts; corrupt/foreign/expired cache files are ignored. No new
durable packet, source-code clone or authorization cache is created.

Retention and human-decision transactions explicitly open a fresh review snapshot with all Git
fact reuse bypassed. They reload live source/artifact/clarification bytes, recompute the binding
and verify HEAD did not move during the check. A post-retention status starts another snapshot,
so it cannot reuse the pre-commit workflow or pointer. Generated agent prompts remain unchanged.

## Reproduction and limits

Use Node 22 in a source checkout with locked dependencies installed:

```sh
node scripts/source-review-benchmark.mjs --engine=/path/to/baseline --samples=3 --history=100 --attachments=16 --output=/tmp/review-before.json
node scripts/source-review-benchmark.mjs --samples=3 --history=100 --attachments=16 --output=/tmp/review-after.json
```

Both engines use the same disposable published-Story fixture and synthetic review report, with
publication-bound human answers, sixteen attachments and one hundred extra commits. Each measured
CLI step runs in a new Node process. Cold means the first context/status request in that fixture;
warm means the immediate repeat with private Git fact storage. OS disk caches are not flushed.
Context/staging/check are verified not to move HEAD; retention runs the real local transaction.
No real Story, application repository, approval, model quota or network push is involved.

Inspect `--timings` for `source-review.inputs`, `source-review.git-batch`,
`source-review.provenance`, `source-review.fresh-binding` and their input-load, blob-hit,
snapshot-hit, provenance-hit and fresh-binding counters alongside `git.spawns`/`git.requests`.
This does not measure Copilot reasoning or human reading time, and makes no full-Story speed claim.
