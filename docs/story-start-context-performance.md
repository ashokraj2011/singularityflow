# Story creation: shared capture and background configuration preparation

## Recorded qualification — 2026-10-21

Three optimizations ship enabled; selected-configuration prewarming is implemented but **opt-in**
because the native Windows prepared-intake cohort regressed. All values below are matched
baseline → candidate medians in seconds, three samples each. Do not pool hosts or interpret a
smaller Git count as proof of a wall-time improvement.

| Request | This Mac | Native Mac CI | Native Windows CI |
| --- | --- | --- | --- |
| Cold Story start, 1k files | 3.269 → 3.169 | 6.767 → 6.788 | 20.944 → 19.366 |
| Runtime-prewarmed Story start, 1k | 3.170 → 3.363 | 5.568 → 6.410 | 20.395 → 19.808 |
| Established workspace, new Story | 2.053 → 1.992 | 4.080 → 4.212 | 12.596 → 12.436 |
| Cold intake + Start, 1k | 4.438 → 4.246 | 9.047 → 8.511 | 25.928 → 24.805 |
| Experimental prepared intake, 1k (not default) | 4.017 → 3.832 | 7.794 → 7.401 | 23.639 → 25.465 |
| Cold Story start, 10k | Not run | 8.062 → 8.857 | 31.206 → 26.786 |
| Runtime-prewarmed Story start, 10k | Not run | 8.320 → 7.876 | 27.845 → 24.473 |

| Request Git launches | This Mac | Native Windows CI |
| --- | --- | --- |
| Cold Story start, 1k | 220 → 218 | 205 → 203 |
| Cold intake + Start | 293 → 276 | 262 → 252 |
| Experimental prepared intake (excluding preparation) | 277 → 270 | 253 → 256 |

The direct Start eliminates one accounting compilation (definition loads 3 → 2; template checks
171 → 114). Intake also shares a verified capture across the outer product gate and Start.
The corrected matched Windows process probe records preview SID queries 3 → 1; ACL application
remains ordered and permissions are still freshly checked. Bounded ancestor batching is separately
tested with actual native Windows ACLs.

Results are mixed: the Windows 10k cold cohort ranges are 23.551–31.769 seconds for control and
25.984–28.387 for candidate, so their overlap and small sample size do not establish a universal
14% improvement. Hosted Mac warm and large cold cohorts worsened. A separate five-sample local Mac
warm confirmation measured 3.265 → 3.218 seconds, versus 3.170 → 3.363 in the primary cohort; both
are retained rather than choosing the favorable result. No slow sample was removed.

The final default guard was then qualified with **25 additional regression cases, no failures or
skips, plus editor typechecking/builds on each native host**. Its separate single-pair intake check
had configuration preparation explicitly off:

| Final default check (one sample, not a performance claim) | Native Mac CI | Native Windows CI |
| --- | --- | --- |
| Cold intake + Start | 7.949 → 10.849 | 28.400 → 25.408 |
| Runtime/worktree-prepared intake + Start | 8.049 → 8.543 | 20.762 → 20.627 |
| Prepared intake including preparation | 10.315 → 10.883 | 25.337 → 24.976 |

These single observations validate the shipped path but are not pooled into primary medians or
used to claim a consistent speedup. Even cold checks have warm OS/binary caches within a runner;
the benchmark does not represent a fresh machine boot for every variant.

In the median Windows 10k cold candidate, worktree preparation took 9.748 seconds and publication
8.179 seconds, versus 0.433 seconds in dispatch. Those nested spans explain the remaining work;
they must not be added to overlapping Git/process totals.

Every latency/Git-count sample, separately charged preparation, selected span/counter summaries,
runtime versions and qualification run IDs are in [the numeric results](story-start-context-results.json).
The additional corrected-probe/default-guard checks are separate samples, not replacements for
these primary medians. Prepared request time excludes preparation in the table; the numeric
results also retain the complete charged total, which can be higher.

The complete modified-area suite passed **260 cases with no failures/skips** on this Mac and native
Mac CI. The corresponding Windows run had 253 passes, six existing POSIX-only skips, and one
Windows path-separator defect in the audit test. That test was corrected without changing runtime
behavior; the **82-case Windows follow-up passed with no failures/skips**, including the corrected
audit. Checks, VS Code typechecking and builds passed on both hosts. This is targeted performance
qualification, not full release qualification.

## Implementation

This change targets the approved-configuration Story creation path. It does not change the
30-minute advisory readiness preferences or reuse old authorization decisions.

1. **Publication metadata and staging.** Exact immutable tree/commit reads share a bounded cache
   inside one publication. Binary bytes, environment selectors and the caller's explicit or
   configured default output ceiling remain enforced. One fresh porcelain-v2 status replaces
   separate tracked/untracked drift reads against the private index. The already-proven exact
   parent tree is reused; final worktree stability, identity, parent validation and ref CAS remain.
2. **One creation capture.** The outer creation request owns verified configuration captures,
   including first-build, intake and Start consumers. Only the same exact authority OID, source,
   environment and capture profile share. Every hit revalidates the private verified snapshot;
   failed loads are not retained. The scope permits four entries/32 MiB and disposes owned scratch
   checkouts at completion. Accounting reads preferences rather than compiling the complete
   workflow a second time; actual policy owners still validate their inputs. Git name/email reads
   use one fresh bounded query instead of two.
3. **Windows system tools.** The current process SID shares only inside this request. Current ACL
   results never share: up to 32 read-only directory checks use one fresh system PowerShell call,
   with a separate fresh file check. Creation/apply remains ordered and topology is checked again.
   PowerShell 5 JSON-array semantics, protected current-user permissions, reparse-point rejection
   and widened-ACL refusal are covered. New spans separate SID, ACL apply/verify and private-path
   topology costs; counters distinguish system-tool queries from Git processes.
4. **Selected configuration preparation (experimental, opt-in).** After an exact passing intake receipt and local
   checkout preparation, VS Code independently schedules `story prepare-configuration` at background
   priority. It releases the receipt before network I/O and holds no exclusive checkout lease.
   Start/cancel never awaits that transfer. The command is advisory, but never result-cached,
   coalesced or sent to a read worker. It fetches only the selected configuration commit's objects
   and replaces one private retention ref, without following a symbolic alias. It does not create
   a Story or change application branches, enrollment, approvals or publication. Start freshly
   resolves authority and validates retained bytes, or uses its normal path when preparation is
   absent, unfinished, stale, disabled or unsupported.

This fourth path is **off by default**. Native Windows prepared-intake measurements regressed
with it enabled (23.639 → 25.465 seconds; request Git launches 253 → 256). Enable it for experiments
by setting `SINGULARITY_FLOW_INTAKE_CONFIGURATION_PREPARATION=on` before launching VS Code. Ordinary
runtime/worktree preparation and the other three optimizations remain enabled. An explicit
`story prepare-configuration` invocation also remains available for exact-receipt experiments.

Preparation can be disabled using `SINGULARITY_FLOW_INTAKE_WORKTREE_PREPARATION=off`. The existing
`SINGULARITY_FLOW_STORY_CONFIGURATION_CACHE=off` also disables selected configuration transfer/use.
No cross-command SID cache, relaxed ACLs or implicit approval were added. The Windows persistent
compiled-definition/object-pool profiles remain disabled unless separately qualified; this
preparation uses ordinary exact objects in the selected repository, not an unqualified pool.

## Measurement protocol

The baseline is `24391a0cf32294924fc7eb4cbc5985c690da3f5b`; the measured CLI candidate is
`392bfaa2ee4da9ccec431ca42275a4505e1da974`. Final guard/preload integration is
`decd97745e48e3392fd3af57add757a9d72d38a5`, without changing that CLI runtime. Synthetic fixtures have 1,000 distinct packed source
files and local bare remotes. Three matched samples alternate candidate/control order. Each engine
has its own installed bundle and source tree, private configuration/compile caches, repository
and identity enrollment. Every measured Story asserts its exact pushed remote tip.
Identities are fixture-only test identities; these runs do not measure human approval or every
production identity lookup. The real Git identity/signing query contract is tested separately.

- Cold: a fresh process, workspace and empty private compile cache; OS file caches are not flushed.
- Runtime-prewarmed: a fresh workspace, with matched runtime preparation charged separately.
- Established: an independent workspace per engine, each given the same initial Story before
  measured new Stories. The old shared-fixture protocol could give the second engine free enrollment
  and state setup; that comparison is no longer used.
- Editor-prepared intake: real selected-base preview/receipt, local checkout preparation and then
  Start. The new candidate-only configuration transfer is also charged separately and in the total.
  This measures a completed background warmup, not a claim that network work is free.

`nodeLaunchedGit` records physical Git child launches, not WAN round trips. The probe also records
whoami/PowerShell counts and inclusive elapsed time, never command arguments, identities, paths,
URLs or credentials. Git/process elapsed totals overlap and must not be summed as a wall-time
breakdown. Named command spans can nest. There are no LLM or native Copilot calls in this profile,
and no attribution to office proxies, antivirus or cloud-folder delays.

The primary three-sample cohorts predate a measurement-preload correction: native Node's custom
`execFile` promisifier bypasses a patched export, and callback `execFile` does not necessarily pass
through that exported `spawn`. The creation Git paths use `spawn`/`spawnSync`/`execFileSync`; their
counts remain captured. Unqualified system-tool fields were excluded rather than presented as
zero. The command's own Windows ACL spans/counters remain valid. The corrected preload is separately
contract-tested on both platforms, with callback/promisified/synchronous processes counted exactly
once, native `{stdout, stderr}`/`.child` behavior preserved, and no payload recorded. Its additional
single matched Story/intake samples are labelled separately, not mixed into primary medians.

## Reproduce

Use an otherwise idle host and the same Node/Git installation for both variants. Substitute the
full baseline OID for `BASELINE`:

```sh
node scripts/story-creation-benchmark.mjs --samples=3 --files=1000 --mode=isolated --configuration=approved --fresh=true --control-ref=BASELINE --out=story-cold.json
node scripts/story-creation-benchmark.mjs --samples=3 --files=1000 --mode=isolated --configuration=approved --fresh=true --prewarm=all --control-ref=BASELINE --out=story-prewarmed.json
node scripts/story-creation-benchmark.mjs --samples=3 --files=1000 --mode=isolated --configuration=approved --fresh=false --prewarm=all --control-ref=BASELINE --out=story-established.json
node scripts/intake-creation-benchmark.mjs --samples=3 --files=1000 --control-ref=BASELINE --out=intake.json
node scripts/intake-creation-benchmark.mjs --samples=3 --files=1000 --configuration-preparation=on --control-ref=BASELINE --out=intake-experimental.json
```

## Safety coverage

Modified-area suites cover request isolation, capture tampering, authority movement, failed reads,
buffer ceilings, encoding, literal paths, staged renames, post-staging edits/deletions/untracked
additions, private-index preservation, ref races, publication crash/recovery, copied configurations,
single-use/stale/foreign receipts, dirty/cancelled/pre-existing worktree preservation, missing
preparation, changed selection, unfinished network work, and uncached background execution.

Native Windows tests use system ACL tools without requesting elevation, not POSIX mode emulation.
Windows Git fixtures use real empty configuration files rather than Node's device-null name;
long recovery refs use Git for Windows' supported long-path setting. Platform-specific cases in
existing suites are reported separately; this is targeted performance qualification, not full
release qualification.
