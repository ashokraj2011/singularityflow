# Source review performance

`/sf-review-source` still performs independent semantic review. This optimization changes only
its deterministic Node/Git reads; it does not remove citation checking, source coverage, reviewer
independence, human decisions or the last fresh retention binding check.

## Read model

One operation shares a commit-bound snapshot across context, private staging and validation.
Named source/artifact/clarification files are read in a verified Git object batch, followed by a
batch of the attachments offered to that phase. No application tree, all-branches scan or broad
history walk is added. Size-first admission caps prefetch at 32 MiB total; files beyond that
optimization budget retain their individual checks and existing review/disposition semantics.
Each live file still passes regular-file/path confinement, byte/hash and
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

The default `--runtime=source` isolates the Node handler changes in a development checkout.
For the installed CLI path, first run `node scripts/build-cli-bundle.mjs` in both engine checkouts,
then repeat with `--runtime=bundle`. This forces that engine's built bundle and refuses a missing
bundle instead of silently falling back to sources. Keep runtime modes separate when comparing.

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

## Local Mac measurements

Three samples per engine on this Mac, Node 22.14.0, against baseline `8dcb3a27`; milliseconds below
are medians. These are process-cold requests, not flushed-disk or freshly booted machine tests.

| Step | Before ms | After ms | Git children before → after |
| --- | ---: | ---: | ---: |
| Context, cold | 1,328 | 1,012 | 39 → 23 |
| Context, warm | 1,171 | 903 | 30 → 12 |
| Private staging | 1,409 | 911 | 52 → 12 |
| Report check | 1,071 | 807 | 29 → 11 |
| Retain, including final fresh check | 3,047 | 2,264 | 150 → 99 |
| Status, first after retention | 1,132 | 905 | 37 → 16 |
| Status, repeated | 1,148 | 864 | 36 → 15 |

The normal context → stage → check → retain → status sequence fell from a median 8,033 ms to
5,894 ms (27%); Git children fell from 307 to 161 (48%). Staging reports one input load and one
snapshot hit; retention reports three independent input loads and one final fresh binding check.
The first post-retention status can reuse immutable facts proved during retention, so its “cold”
label is not a claim that the provenance store is empty. Only successful fixture runs enter these
latency samples. One separate local attempt refused during accepted-Story bootstrap because a
creation-history Git object was unavailable, before source-review input loading; its refusal was
not masked or counted as a successful sample. The subsequent complete three-sample run passed.
