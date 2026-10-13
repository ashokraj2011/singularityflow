# Proposal performance pass — 2026-10-13

Baseline: main `957a4c8923db885d896066fad00722785fd9cc7b`.
Runtime: macOS, Node 22.14.0; three fresh-process samples per action; 1,000 tracked
application files, one configuration proposal, a disposable local bare remote, no model.

| Action | Before Git processes | After Git processes | Before median ms | After median ms |
| --- | ---: | ---: | ---: | ---: |
| Cold proposal list | 63 | 48 | 1,160 | 1,029 |
| Warm proposal list | 10 | 10 | 683 | 618 |
| Exact review | 62 | 47 | 1,091 | 986 |
| Confirmed activation | 110 | 78 | 2,011 | 1,675 |

The VS Code-shaped command sequence formerly ran review, an unacknowledged activation refusal,
then acknowledged activation. It now runs review and one acknowledged activation. Summing the
paired samples gives 235 → 125 Git processes (47% fewer), 3 → 2 clones, and a median command
wall time of 4,981 → 2,770 ms. Human review/confirmation time is excluded. The sample is small,
and host contention varied: the process-count reduction is deterministic, but the wall-time
comparison is not a universal speed guarantee. Office Git latency and native Windows timing
remain unmeasured. No server-side protection or remote verification was bypassed.

A 10,000-file scale probe retained the same 47-process review and 78-process activation counts.
That is a subprocess-growth check, not a claim of constant transfer bytes or wall time.

The final benchmark harness additionally neutralizes ambient Git selectors and global
hooks/fsmonitor settings. That isolation adds one readiness query per CLI invocation: a final
1,000-file probe reported 48 review / 79 activation processes. The table above records the
earlier paired measurements; the extra harness query does not change the product's reduction.

The remaining cold clone/fetch, full validation, durable journal, real leased push, post-push
observation and workspace-reference refresh are still paid. This change does not introduce a
cross-invocation authority cache or claim that large repository transfer is free. A server that
does not support partial clone can still transfer extra historical application objects.

Reproduce from either checkout with the same Node and fixture:

```sh
node scripts/proposal-performance-benchmark.mjs --source=<baseline-checkout> --samples=3 --files=1000
node scripts/proposal-performance-benchmark.mjs --samples=3 --files=1000
```

Verification includes exact-confirmation and human-consent ordering, no automatic retries,
local-config seal invalidation, explicit-fetch invalidation, immutable inventory admission,
bounded cache size, competing semantic changes, interrupted pushes, server refusal, journal
failure and preservation of dirty application bytes/index. The package, extension typecheck,
bundle build and reviewed Git-access audit are required before merging.
