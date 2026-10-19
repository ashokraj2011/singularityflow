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
The driver launches Node directly, so PowerShell startup and VS Code/Copilot transport overhead
are outside the measurement. The original tables below used V8's normal shared compile cache;
the cold fast-path protocol isolates it per sample as described next.

## Cold review fast path

Read-only `review-source context`, `check` and `status` share configuration-source reads for one
invocation, including accounting preferences. They do not load the current full agent catalog or
validate every template merely to log a command. The accepted Story bootstrap and saved execution
catalog remain authoritative. Stage, retain, human decisions and override forms do not inherit
this read scope; their identity, lifecycle and publication checks remain fresh.

The common phase binding and pure input/inspection/metadata helpers are separate from phase
authoring, recovery and publication writers. Review context uses the narrow read bundle slot;
publication/recovery loads only when a mutating route needs it. The installed envelope remains
twenty files, rather than trading a smaller import graph for hundreds of Windows file opens.

Immutable provenance cache lookups coalesce dependency metadata within one synchronous group,
verify the metadata again before returning, then discard that observation. A change during the
group takes the ordinary individual path. Fresh retention bypasses cached answers exactly as
before. Singletons and pairs keep the ordinary checked path: grouping cannot save probes for
them and must not add another object-store inventory scan. Exact commit/parent/path provenance
reads can use one bounded, object-hash-verified Git
batch; missing, oversized, incomplete or corrupt output retains the sized fallback and refusal.
Attachment prefetch remains size-first and limited to 32 MiB. Movable refs do not use this path.

The benchmark now retains per-command stage/span timings, configuration-load counts and bounded
local Git verb/service counters. No arguments, paths, identities or remote URLs become timing
keys. An isolated V8 compile-cache directory per sample makes the first context request
compile-cold; its immediate repeat measures compiled-code and Git-fact reuse. Earlier tables below
predate that isolation and must not be directly combined with the new cold-cache measurements.
In all profiles OS caches remain unflushed, status runs after retention, and network/model work is
excluded. Retention already returns its verified status and continuation; a consumer need not ask
for another status just to display the same result.

For comparisons on a host whose load changes, alternate the engines instead of measuring every
baseline sample before every candidate sample:

```sh
node scripts/source-review-paired-benchmark.mjs --baseline-engine=/path/to/baseline --samples=6 --runtime=bundle --output=/tmp/review-paired.json
```

This runs A/B then B/A pairs on separate disposable fixtures with independent compile caches,
retains every observation and prints a compact summary. Both small and larger profiles run by
default; `--profile=small` or `large` selects one. An even sample count is required so each engine
is measured first equally often. This reduces order bias; it does not flush OS caches or turn a
short benchmark into a universal latency guarantee.

## Local Mac source-mode measurements

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

The kernel-staging context → stage → check → retain → status sequence fell from a median 8,033 ms to
5,894 ms (27%); Git children fell from 307 to 161 (48%). Staging reports one input load and one
snapshot hit; retention reports three independent input loads and one final fresh binding check.
The first post-retention status can reuse immutable facts proved during retention, so its “cold”
label is not a claim that the provenance store is empty. Only successful fixture runs enter these
latency samples. One separate local attempt refused during accepted-Story bootstrap because a
creation-history Git object was unavailable, before source-review input loading; its refusal was
not masked or counted as a successful sample. The subsequent complete three-sample run passed.

## Local Mac installed-bundle measurements

With both cold-layout CLI bundles built and explicitly selected, the same three-sample corpus
improved from a median 4,996 ms to 4,206 ms for context → stage → check → retain → status (16%).
Cold context improved from 779 to 719 ms; warm context from 721 to 633 ms; private staging from
878 to 611 ms; check from 591 to 532 ms; retention from 2,029 to 1,801 ms. Git-child reductions
are the same as the source-mode table. Every staged packet reused one input snapshot and every
retention performed exactly one fresh binding check. These results qualify the installed command
path, not just the development dispatcher; no model reasoning or network publication is timed.
This sequence uses the supported `review-source stage` kernel route. A Copilot host that writes
the issued private staging file directly omits that CLI step; its end-to-end gain will differ.

The separate hosted macOS runner (Node 22.23.3, source runtime) showed smaller sequence gains:
4,432 → 4,300 ms (3%) for the larger corpus and 3,471 → 3,090 ms (11%) with no extra attachments
or history. Some individual larger-corpus steps were 8–9% slower even though Git children fell.
Three-sample measurements are directional, not a universal latency guarantee; fixed startup,
catalog loading and filesystem costs remain, and counts are more stable than short wall timings.

## Native Windows installed-bundle measurements

A temporary Windows runner, Node 22.23.3, built both CLI bundles from the same baseline and
optimized sources. Three samples per engine used the same harness and corpus dimensions.

| Larger corpus step | Before ms | After ms | Git children before → after |
| --- | ---: | ---: | ---: |
| Context, cold | 1,650 | 1,348 | 40 → 24 |
| Context, warm | 1,568 | 1,120 | 35 → 19 |
| Private staging | 2,000 | 957 | 52 → 14 |
| Report check | 1,246 | 783 | 29 → 11 |
| Retain, including final fresh check | 5,070 | 3,784 | 150 → 99 |
| Status, first after retention | 1,633 | 1,108 | 41 → 22 |
| Status, repeated | 1,531 | 1,112 | 39 → 22 |

The sequence median fell from 11,570 to 8,050 ms (30%). On the small corpus (no extra attachments
or history), it fell from 8,330 to 7,741 ms (7%); cold context was essentially flat, 1,229 versus
1,231 ms. A bundle-specific check also verified shared staging snapshots and exactly one fresh
binding check in each of the six optimized retention runs. Native Windows qualification uses a
hosted runner, not an office laptop with its security filters, cloud storage and shell setup.

## Qualification record

The source-runtime Windows sequence measured 18,856 → 13,761 ms (27%) on the larger corpus and
13,701 → 14,097 ms (3% slower) on the small corpus. Runtime modes and machines must not be mixed
into one speedup claim. The clearer installed-runtime gains above are the relevant deployment path.

Native qualification run `39183229972` passed all 168 broader cases on macOS. Windows passed 167;
the sole failure was an existing test comparing Git's expanded Windows path with an 8.3 alias.
The assertion now compares both native canonical paths and still requires byte-identical cached
answers. No runtime validation was relaxed. Follow-up run `39185311144` passed all 54 cache,
path and source-review lifecycle cases on **both** hosts, along with 2,768 product checks, VS Code
typechecking and builds. Windows installed-bundle run `39184156814` passed both benchmark profiles
and its explicit shared-snapshot/fresh-retention assertions. All review CLI cases from the broader
Windows run passed; the follow-up reran the corrected fixture and affected cache/binding suites,
not the entire broader corpus. Qualification workflows are temporary CI-only assets, not product
files or workflows merged into main.
