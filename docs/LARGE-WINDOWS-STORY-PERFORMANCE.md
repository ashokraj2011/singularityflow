# Large Windows isolated Story creation

## What the 46-second report actually measured

The earlier retained Windows pair recorded 46.31 seconds for its control and 46.15 seconds
for its candidate. It was one pair, not a latency distribution. Its candidate spent 12.89 seconds
loading configuration, 8.79 seconds checking out application files, 4.34 seconds enrolling the
identity, and 10.28 seconds in the publication transaction. Readiness itself took 3 milliseconds.
Spans are nested and must not all be added together.

The large fixture represents a supported historical configuration layout: its approved
`sflow/config` branch still contains the application's 10,000 files. A full configuration clone
checked those unrelated files out, enrollment refreshed them, and disposal removed them again.
Reducing three configuration clones to one did not eliminate that remaining full checkout.
Modern configuration-only/orphan branches do not have this particular application-file penalty.

## Change

Story configuration reads now clone without checkout and project only the committed approved
asset inventory through a non-cone sparse checkout. The selection includes custom template,
agent and prompt roots, and ancestor attribute/ignore files. Literal glob characters are escaped.
Generated World Model and other runtime paths remain excluded by the existing asset policy.
The projection uses clone-local sparse settings and an exclusively created pattern file followed
by `read-tree -mu`, avoiding a newer sparse-checkout option and another Git process. No existing
metadata file or caller sparse policy is overwritten.

The clone still has the complete Git parent/index. Its scoped enrollment commit preserves
unmaterialized application files, runtime files and unrelated trees exactly. The existing full
snapshot validator, committed skill-byte closure, fresh authority check, one-use checkout lease,
exact-parent enrollment publication and cleanup ownership still apply. No persistent Windows cache
is enabled, no user index is borrowed, and Story publication remains synchronous with exact-tip
verification. The real Story worktree still gets the complete application checkout.

Immutable policy reads use the exact observed commit, allowing the existing per-commit cache to
serve projection and validation without repeating policy reads under mutable `HEAD`.

Publication timings now separate state writing, prospective-tree admission and Candidate
verification. The benchmark retains bounded Git verb elapsed totals without paths or URLs.
Those totals are inclusive per process, can overlap parent/child processes, and omit some
remote commands executed under isolated transport. They are not exclusive wall-clock attribution.

## Qualification

The [initial three-pair Windows report](../benchmarks/story-creation/large-projection-windows.json)
binds source `f6f8eb18b26cb5f9d1e0436008058d04009308ec` to baseline
`3fd3db0b0ba1dbfdeb74ffa72b614441212cae35`. CI run `38956904026` passes the performance
job. Its separate regression job exposed the two portability fixtures corrected below; the
overall run is recorded as failed, not silently presented as an all-green qualification.

| Three fresh native Windows pairs | Baseline | Initial projection |
| --- | ---: | ---: |
| Complete creation median | 31,236 ms | 14,272 ms |
| Complete-run range | 18,463–32,810 ms | 13,869–15,432 ms |
| Configuration authority median | 4,184.9 ms | 985.3 ms |
| Enrollment median | 2,086.1 ms | 1,549.3 ms |
| Application checkout median | 4,258.2 ms | 4,372.6 ms |
| Publication transaction median | 3,646.3 ms | 3,651.8 ms |

Every candidate beats its matched control. The measured complete-run median is 54.3% lower,
but this is not an office-laptop guarantee or a claim that every saved millisecond is caused by
projection: one control application checkout takes 13.92 seconds, and the controls also show
enrollment and end-of-process variability (the latter is not separately attributed to cleanup).
The directly targeted configuration read consistently falls
from 4.12–8.01 seconds to 0.96–1.06 seconds. Readiness remains approximately 1.4 ms.
First feedback is not improved. Git launches increase in this initial implementation; the gain
comes from avoiding unrelated file I/O, not fewer Git processes. Later plumbing removes an
extra launch and exact-commit policy reads avoid duplicate lookups.

The [final exact-source Windows smoke](../benchmarks/story-creation/large-projection-windows-final.json)
binds `56e635657898e6f9567f4fefc7277ef1f5e82629` to successful CI run `38958685028`.
This complete-inventory version creates and publishes a 10,000-file Story in 18,776 ms with an
exact remote tip. It is one unpaired sample, not a new speedup distribution. Configuration authority
takes 1,424.1 ms, enrollment 2,172.4 ms, the required application checkout 5,863.6 ms, and publication
4,584.5 ms. It records 168 Git launches, one configuration clone and 161 projected assets. The real
application checkout and synchronous publication are now the largest measured remaining spans.

The same final-source run passes nine configuration/projection/ownership tests, nine publication
and intake tests (including the real remote-retarget race), TypeScript and bundle limits. The
renamed smoke file missed its CI upload glob; its complete raw report is retained from the
successful job log with that provenance recorded, rather than claiming an artifact was uploaded.

The corrected full Windows regression run `38957991432` also succeeds: eight configuration tests,
203 publication/recovery/isolation/intake tests, eight explicit platform skips, no failures,
TypeScript and bundle limits. That run binds source `41a7d950d786326ba97e253744d09d94225dba75`;
the subsequent exact-source run above requalifies the final plumbing and complete-inventory guard.

The [intermediate exact-commit-policy report](../benchmarks/story-creation/large-projection-windows-policy.json)
binds source `e45a98fd601b3370f5ce6b10fa9b6092cef02917` to CI `38957530274`.
Its 10,000-file pair measures 25,865 ms control and 19,451 ms candidate. Its three 1,000-file
pairs measure 16,912 ms control median (14,750–19,903) and 14,408 ms candidate median
(14,360–15,465), all exact tips and each candidate faster. This is a pre-plumbing measurement,
not a final-source performance distribution; its overall CI run still failed the old fixtures.

A subsequent [plumbing paired attempt](../benchmarks/story-creation/large-projection-windows-setup-failure.json),
CI `38958491802`, passes its regression job but fails in fixture `git add .` after the existing
120-second setup limit. That is before the failed sample's Story invocation, not an observed
Story timeout; no timing report survived this run. The final exact-source smoke above succeeds
independently. The setup timeout was not enlarged and no product deadline or Git policy relaxed.
The production tree never contains the temporary hosted workflow.

The [three-pair Mac report](../benchmarks/story-creation/large-projection-macos.json) binds
final runtime source `56e635657898e6f9567f4fefc7277ef1f5e82629` to main baseline
`3fd3db0b0ba1dbfdeb74ffa72b614441212cae35`. Median complete creation improves from
5,052 to 4,416 ms (12.6%). Controls range 5,026–5,054 ms; candidates 3,918–4,455 ms.
Every candidate is faster than its matched control and every remote tip is exact. These samples
share the desktop with other work, and do not replace native Windows qualification.

The Mac regression groups pass 136 configuration/materialization/publication/isolation tests
and 184 publication fault/recovery/worktree/batching tests. The configuration group explicitly
excludes the previously reproduced baseline-only state-mirror resume failure named
“Story start recovers from a verified state mirror when sflow/config is unavailable”.
It is not silently counted as a pass.

The added projection regression proves custom paths containing glob syntax, ancestor policy
files, absent application/runtime files, clean sparse status, exact enrollment parent, and
unchanged omitted tree IDs. Existing tests cover CRLF, forged/stale handoffs, concurrent owners,
secret refusal, Candidate drift, index preservation, transport failure and recovery.
An injected omission of a non-skill policy is refused before a snapshot can escape. Every direct
snapshot (including a derived object-cache read) must match the entire committed asset inventory;
projection is never permission to omit an inconvenient configuration file.
The remote-retarget race fixture uses a process-local ESM interception of the completed real
transport, not a POSIX PATH shim that Windows never executes. Its assertion proves the race
actually fired before checking refusal. The intake-cache test asserts the fresh independent
reader on Windows, where the persistent cache deliberately remains disabled.

Final Mac validation additionally passes all 58 configuration/materialization tests (with the
same named baseline resume exclusion) and 56 object-cache, approved-skill and Git-audit tests.
The release check passes 2,619 checks; TypeScript and all existing bundle ceilings pass without
raising a budget. The earlier publication/recovery groups remain separately recorded above;
overlapping groups are not summed into a fictitious unique-test total.

## Main integration

The final pre-merge fetch still resolves main to
`3fd3db0b0ba1dbfdeb74ffa72b614441212cae35`, the fresh-clone baseline. No intervening upstream
work is overwritten. Production integration is a fast-forward containing no hosted-workflow files;
temporary native-qualification refs are removed after their completed runs and reports are retained.

## Reproduce

```sh
node scripts/story-creation-benchmark.mjs --mode=isolated --fresh=true --configuration=approved --samples=3 --files=10000 --control-ref=3fd3db0b0ba1dbfdeb74ffa72b614441212cae35 --out=large.json
```

Candidate/control alternate in fresh repositories and private compile-cache directories using
the same installed packaging. Every run verifies the exact remote Story tip. Models and tests
are not run during intake. The remote is local bare Git; OS caches are not flushed. These are
native CLI-path measurements, not office-laptop antivirus/network or native VS Code paint timings.
