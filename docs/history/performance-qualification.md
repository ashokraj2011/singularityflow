# Historical performance qualification

Consolidated delivery and qualification records. Each entry retains its original feature scope, measurements, validation and limitations; these records do not establish a new release certificate or change current product defaults.

Use the [documentation map](../DOCUMENTATION-MAP.md) for current guides and the [pending-work roadmap](../PENDING-WORK-ROADMAP.md) for outstanding work.

## Contents

- [Cold-start and native intake performance](#cold-start-and-native-intake-performance)
- [First-request isolated Story performance](#first-request-isolated-story-performance)
- [Story creation performance](#story-creation-performance)
- [Large Windows isolated Story creation](#large-windows-isolated-story-creation)
- [Bound phase and next-step performance](#bound-phase-and-next-step-performance)
- [Publication context and first-write qualification](#publication-context-and-first-write-qualification)
- [Shared-read performance](#shared-read-performance)
- [Source review performance](#source-review-performance)
- [Story creation: shared capture and background configuration preparation](#story-creation-shared-capture-and-background-configuration-preparation)
- [Workspace creation and Story intake qualification](#workspace-creation-and-story-intake-qualification)
- [Shared worktree and cold phase performance](#shared-worktree-and-cold-phase-performance)

## Cold-start and native intake performance

The installed CLI uses coarse ESM bundles instead of parsing the entire legacy engine on every
request. There are at most 21 generated module files, including six private worker/CLI entries.
Static dependency closures are assigned once in priority order. Shared error classes, operation
contexts, read scopes and mutable caches keep one identity. New inter-chunk static cycles fail
the build. Worker programs with top-level listeners are never merged into shared chunks.

The CLI's initial static closure is about 1.33 MB rather than the monolithic control's 16.49 MB.
Tiny common helpers matter: the deferred-index completion check is a core dependency, not a route
through the compatibility/admin chunk. Status, session, intake, hooks and maintenance have explicit
families; unrelated domains stay deferred. Esbuild compacts whitespace and syntax for Node 20
after Rollup assigns modules; it retains identifiers and does not re-bundle or duplicate them.
The old monolithic layout remains an explicit control. The root error boundary reads attached
result metadata directly from the command-result contract, not through the output module and
its workflow planner. The status budget and a dependency-exclusion regression guard that boundary.
See [CLI status bundle hardening](completed-fixes.md#cli-status-bundle-hardening) for the subsequent native
macOS/Windows qualification and unchanged closure limits.

Bundle format 2 retains live build-stamp validation and source fallback. One directory roster
checks the generated regular files, rather than one stat per chunk. Missing files, unsupported
formats and unsafe names use the source runtime. Format 1 installations remain compatible.

### cold start performance — One native Copilot intake entry

`/sf-start` begins with:

```sh
singularity-flow workspace branches --entry --intake --work-id YOUR-ID --for-agent --json
```

Pause precedes Git. The packet combines the refreshed selected workspace, installed build,
personalized reply name, clean-tree check, existing-ID check and canonical branch/workflow
catalog. It asks for explicit choices; it does not authorize creation. Missing selections, dirty
work and existing IDs remain distinct conditions. The ordinary selected-base preflight and its
private receipt stay separate. Creation revalidates live authority and repository deltas.

The branch-preview implementation is shared by the thin workspace command and the legacy route,
not copied into a second readiness engine. No global workspace-health scan or duplicate CLI
lookup is required just to obtain the same intake facts. `act` differentiates asking for choices
from continuing after a passing selected-base preview, avoiding a new preview loop.

### cold start performance — Optional bytecode preparation

VS Code can also prepare the exact selected runtime after its interactive intake catalog loads;
see [First-request isolated Story performance](performance-qualification.md#first-request-isolated-story-performance) for its
separate preparation cost, cancellation behavior and fresh-request measurements.

Hooks now enable Node's compile cache where its APIs are available, as the CLI already did.
The installer and reinstall transaction run `singularity-flow --warm-runtime` after verifying the
final installed build. This imports an allowlist of pure startup-definition chunks; it does not
dispatch repository commands, worker programs, tests, models, approvals or publication.

An unsupported runtime, disabled/unwritable cache or failed preparation falls back to normal
execution and does not fail installation. Installation cancellation is still honored. A different
Node/runtime/source/path invalidates the bytecode cache normally. No authority or permission
decision is cached. Verified hook executable discovery remains unchanged; this work does not
trade executable validation for a blind PATH cache.

### cold start performance — Local qualification

For the subsequent transaction-level Story creation analysis and fixes, see
[Story creation performance](performance-qualification.md#story-creation-performance). The table below remains the original
packaging comparison, not the later before/after creation comparison.

Run the portable paired fixture with:

```sh
node scripts/cold-start-benchmark.mjs --samples=5 --files=1000
```

[Machine-readable results](../../benchmarks/cold-start/local-macos.json) record the runtime, complete
manifests, protocol and distributions. The recorded run used macOS arm64, Node v25.5.0, five samples,
1,000 source files, 20 unrelated branches and a local bare remote. CLI/intake samples alternate
layouts. Each cold sample has a fresh private compile-cache directory; a subsequent child process
uses that directory again. The OS file cache is not flushed. There are no model calls or public
remote operations, and each created Story's exact published remote tip is checked. Fixtures are
removed in `finally`.

| Measured stage | Monolithic control | Coarse bundles / composed intake |
| --- | ---: | ---: |
| Version, empty compile cache | 263 ms | 82 ms |
| Pause, empty compile cache | 267 ms | 105 ms |
| Repository slice, empty compile cache | 317 ms | 156 ms |
| Status, empty compile cache | 285 ms | 189 ms |
| Next steps, empty compile cache | 343 ms | 267 ms |
| Empty guard hook, empty compile cache | 155 ms | 84 ms |
| Initial intake lookup sequence | 895 ms | 391 ms |
| Story creation and publication after that lookup | 1,412 ms | 1,493 ms |
| Current-session lookup, empty compile cache | 538 ms | 547 ms |

These are medians, not guarantees. Initial intake lookup improves about 56%, but creation alone
is about 6% slower in this fixture and current-session lookup is essentially unchanged. Do not
describe this as a universal speedup or a measured complete-Story/model-token saving. The intake
comparison includes eliminating four separate CLI launches plus a Git-status lookup; the other
comparisons isolate packaging on the same source. The monolithic control already contains the
new canonical branch-preview extraction, so this is not a claim to measure every change against
the previous release.

Native Windows timing, PowerShell startup, antivirus/OneDrive effects, native Copilot round trips,
enterprise network latency and full repository histories remain unqualified. The Windows path-ID
mapping and portable code paths have regression tests, but are not a substitute for running this
fixture and a real intake on Windows. Fresh publication, identity, authority, review and test
semantics are unchanged. Author and independent-reviewer execution are not combined.

### cold start performance — Regression coverage

Tests cover source/bundle CLI output and refusal parity, edit denials, private worker isolation,
shared module identity, Windows-style module IDs, complete deployment/stamp selection, missing
chunks, packaged resource paths, optional prewarming without worktree changes, pause before Git,
canonical intake choices and draft preservation. Installed VS Code staging is exercised as well;
new runtime files must be committed before its tracked-payload staging can qualify them.

Existing generation, publication, submission, approval-authority and independent source-review
tests were also run with the bundled CLI selected. The repository checker validates the locked
dependency closure, revision producer hash, generated skills/help catalogs and reviewed Git sites.

## First-request isolated Story performance

This follow-up adds Git batching, shared approved-configuration compilation and optional
VS Code runtime prewarming. It builds on [isolated creation](../ISOLATED-STORY-PERFORMANCE.md),
not a replacement readiness/approval engine. The paired control is main at
`ec2a79213f1729f6170265cbb4c737faf213e011`. Raw macOS results are retained in
[first-request-macos.json](../../benchmarks/story-creation/first-request-macos.json).

### first request story performance — What changed

- **Batch stable Git discovery.** One `rev-parse` obtains the repository root, private Git
  directory and common Git directory. Directory-only callers share one two-answer probe.
  A fresh selected-base ref observation supplies both existence and commit ID. Branches,
  HEADs, readiness, permissions and authority are not newly cached. Resetting directory
  caches also clears the common-directory answer.
- **Reuse compilation, not approval.** After approved configuration is materialized, compare
  its exact raw bytes, complete governed asset membership, source repository, source commit
  and Git descriptors with the owner-verified in-memory snapshot. Only then copy/rebind its
  compiled definition. The normal definition reader still checks live output-root containment,
  portfolio and environment exclusions. A consumer gets its own copy. Legacy commit overlays
  use a fresh bounded read scope for repeated definition loads; a mutating Story transaction
  does not share a general read scope.
- **Prepare the runtime actually used by VS Code.** After the intake catalog has loaded,
  optionally call the selected Node executable and CLI with `--warm-runtime`, using the
  actual command environment. Check the selected format-2 bundle's build stamp first.
  Start and panel disposal cancel optional preparation; neither waits for it. The preparation
  code is a separate lazy `runtime-prewarm.cjs` entry, not a new activation module.
  Concurrent identical preparations share one invocation; the in-memory map is bounded to
  eight entries, keyed by executable, CLI, full environment digest, manifest and build stamp.
  Failure, cancellation, unsupported caches, source-runtime opt-out or cwd-dependent relative
  overrides leave ordinary commands available and do not cache a success.

Prewarming only imports the existing allowlist of startup definitions. It does not run Git,
read repository state, dispatch a workflow command, call a model, run tests or make an approval.
It is an accelerator, never a readiness witness. It preserves Node/Electron execution flags,
compile-cache opt-out, explicitly selected bundle paths and the normal installed-build checks.

The activation module limit and total JavaScript budget are unchanged. The new lazy preparation
entry is bounded to 110,000 bytes / 24 modules. The intake panels have a reviewed 1,000-byte increase.
At final merge the gateway retains newer main's 7,505,000-byte limit; its combined measured size is
7,502,063 bytes. This replaces this branch's earlier 1,000-byte adjustment, not an additional
relaxation of the upstream limit.

### first request story performance — macOS qualification

Five alternating samples per variant; a fresh repository and a fresh private Node compile cache
for **every** sample. Each repository has 1,000 application files, the stock feature workflow,
an approved local `sflow/config` authority and a local bare publication remote. The benchmark
asserts the exact local and remote Story tips. OS file caches are not flushed.
Host: macOS arm64, Node v25.5.0, Git 2.54.0. No tests ran alongside these measurements.

| Independent comparison | Control median | Candidate median |
| --- | ---: | ---: |
| Cold complete creation/publication, no prewarm | 3,274 ms | 3,578 ms |
| Cold first feedback, no prewarm | 352.6 ms | 367.1 ms |
| First feedback after optional preparation | 346.9 ms | 270.2 ms |
| Creation/publication after optional preparation | 3,190 ms | 3,061 ms |
| Preparation plus creation, counted together | 3,190 ms | 3,243 ms |

The final cold rerun is about 9.3% slower, with overlapping ranges and large outliers in both
variants: control 3,210–5,041 ms, candidate 3,276–5,421 ms. An earlier
[preliminary run](../../benchmarks/story-creation/first-request-macos-preliminary.json) was 2.1%
faster instead (3,224 ms control, 3,155 ms candidate). Retain both runs; these data do not establish
a consistent end-to-end cold speedup. Variable authority/enrollment/publication spans dominate
the noisy samples, rather than the small configuration-compilation saving.

The separate final prewarming comparison lowers first feedback about 22.1%, but moves work
earlier: preparation itself takes a median 182 ms and increases total counted work. The earlier
prewarm run also improved feedback about 21.4%, with approximately unchanged end-to-end latency.
The panel starts preparation only after its initial catalog read, so this does not claim to
accelerate the initial opening of intake. No samples are dropped or combined across revisions.

In this approved-configuration fixture, candidate traces show 198 Git processes versus 200 and
five full configuration loads versus six, with one verified materialized-definition reuse.
This is not a claim that the transaction now launches only one Git process or reads YAML once.
Fresh authority, enrollment and publication checks remain substantial work.

### first request story performance — Native Windows: reject the expensive cache default

The [intermediate cold results](../../benchmarks/story-creation/first-request-windows-intermediate.json)
record a real hosted Windows x64 runner, Node v24.21.0 and Git 2.56.0.windows.2. Three alternating
samples per variant use the same fresh-repository / fresh-compile-cache / 1,000-file protocol.
This candidate had the repaired Windows ACL implementation **but still enabled persistent
compiled-definition caching by default**.

| Intermediate cold comparison | Main control median | Candidate median |
| --- | ---: | ---: |
| Complete creation and publication | 28,071 ms | 56,866 ms |
| First feedback | 1,643.0 ms | 1,329.1 ms |
| Authority span | 5,291.9 ms | 21,167.6 ms |

Native correctness tests, type checking and bundle limits passed, yet complete creation regressed.
The fresh private cache's native ACL setup/verification overwhelmed the parsing saving. Keeping
this default would have shipped a performance regression. The final Windows policy therefore
uses fresh parsing plus the verified in-memory definition sharing by default; authenticated disk
caching remains available with an explicit `on`. No permissions are skipped when that cache is used.
The intermediate prewarmed comparison was intentionally cancelled after the cold report completed;
its status is not presented as a successful full qualification. Its completed cold data and
run record (CI run `38929944003` in the source repository) are retained.

### first request story performance — Final native Windows qualification

The [final Windows results](../../benchmarks/story-creation/first-request-windows.json) use the same
protocol and runtime as the intermediate exploration, with the final Windows cache default.
CI run `38930959716` passed both native test groups (38 passed, two pre-existing platform-specific
skips), type checking, bundle limits, and the cold and prewarmed comparisons. No model was called.

| Three matched samples per variant | Main control median | Final candidate median |
| --- | ---: | ---: |
| Cold complete creation/publication | 21,568 ms | 18,313 ms |
| Cold first feedback | 1,347.3 ms | 1,268.2 ms |
| First feedback after optional preparation (separate comparison) | 1,458.1 ms | 1,225.4 ms |
| Creation/publication after preparation (separate comparison) | 29,745 ms | 24,330 ms |
| Preparation plus creation, counted together | 29,745 ms | 25,005 ms |

Cold complete creation improves about 15.1% in this fixture. Candidate samples range from
18,180–18,595 ms; control samples range from 20,728–30,069 ms. Each matched candidate is faster,
but three hosted-runner pairs are not an office-laptop latency guarantee.

In the independent prewarmed comparison, first feedback improves about 16.0%; preparation itself
costs a median 509 ms. Its complete-creation improvement is about 18.2% (15.9% when counting
preparation too). Both variants in this second batch are slower than in the cold batch; do not
compare the two candidate medians as though they were a controlled warm-versus-cold experiment.
The candidate ranges 20,946–35,078 ms and control 23,828–36,937 ms, so host variability remains material.

The final Windows traces show 166 Git processes versus 170, five full definition loads versus six,
and retained verified materialized-definition reuse. The additional reduction versus the Mac
counts comes from avoiding the optional private disk-cache path. All local/remote Story tips
match exactly. This is a real Windows CLI measurement, not native VS Code UI or Copilot timing.

#### first request story performance — Latest-main integration

The timing baseline remains `ec2a7921` and the Windows candidate is `aed2bb5a`; raw records bind
those revisions. Main subsequently advanced to `3568c1af`. Its five commits (skills-audit and
step-owned-artifact recovery fixes plus gateway budgets) were inspected and merged, not overwritten.
The combined build passes the newer upstream gateway budget without raising it again, and the
86 affected Mac phase-entry, recovery and polyglot tests pass. The merged source also passed a
separate native Windows run (CI `38933205030`): Git/configuration/recovery/prewarming tests,
the default-cache policy test, type checking, bundle limits and one fresh approved-configuration
isolated creation with exact local/remote tip verification. Its
[raw smoke record](../../benchmarks/story-creation/first-request-windows-merged-smoke.json) has zero
application files and one sample: it verifies integration, not a performance distribution.
Do not relabel the earlier timing distributions as measurements of this later merged revision.

The final pre-push refresh also integrated `7a7ee3c8` (the Start skill's registry budget and
boundary tests). It changes no JavaScript runtime code. The resulting source check passes 2,618
checks and the 23 path-grounding / skill-efficiency tests pass; no upstream change was discarded.

### first request story performance — Reproduce on either operating system

The Windows exploration below explains why the persistent compiled cache is opt-in there.
It does not change the baseline reference used by either paired comparison.

With the target revision committed and dependencies installed, run these commands separately
on a quiet host. The script creates and cleans its own temporary local repositories/caches.

```sh
node scripts/story-creation-benchmark.mjs --mode=isolated --fresh=true --configuration=approved --samples=5 --files=1000 --control-ref=ec2a79213f1729f6170265cbb4c737faf213e011 --out=first-request-cold.json

node scripts/story-creation-benchmark.mjs --mode=isolated --fresh=true --configuration=approved --prewarm=candidate --samples=5 --files=1000 --control-ref=ec2a79213f1729f6170265cbb4c737faf213e011 --out=first-request-prewarmed.json
```

The benchmark options default to previous behavior when omitted. `--fresh=true` isolates first
requests rather than measuring repeatedly warmed Stories in one repository.
`--configuration=approved` includes shared authority and first-start enrollment.
`--prewarm=candidate` separately reports preparation and combined elapsed work.
`--files=10000` tests a larger checkout; small-fixture figures must not be generalized to it.

### first request story performance — Safeguards and limits

Native qualification also exposed Windows bugs that portable mocks did not catch. PowerShell
ACL scripts now bind their inputs as quoted data in an encoded command, rather than relying on
trailing `-Command` arguments to populate `$args`. Single-target ACL application uses the same
canonical current-user-only rule construction as recursive application, without traversing
children. Reads still refuse unqualified existing ACLs; they do not silently repair permissions.
The optional persistent compiled-definition cache is now explicit opt-in on Windows
(`SINGULARITY_FLOW_COMPILED_CONFIGURATION_CACHE=on`): its native ACL qualification work must not
be imposed on every cold request. Fresh definition validation and owner-verified in-memory sharing
remain the default; this disables an accelerator, not a policy check. Other operating systems
keep their existing disk-cache default, and `off` still disables it everywhere.
The native test covers real private sidecar publication plus spaces, apostrophes, metacharacters
and Unicode. Git batching also preserves cwd-relative common-directory spelling for aliases;
the optimization must not break private-path containment checks.

Regression tests cover linked/bare Git directories, branch changes, recreated repository paths,
unchanged source indexes, raw byte/asset-set drift, altered snapshots, live output-root escape,
separate consumer definitions and fresh legacy read scopes. Runtime tests cover exact environment
selection, selected-bundle changes, opt-out, cancellation, retry and lazy packaged entry selection.
Existing selected-base, Story receipt, start/publication, package and agent-output tests preserve
their authorization and race checks.

The backing CLI transaction is measured, not native VS Code paint or Copilot/model round trips.
A hosted Windows runner is not a substitute for an office laptop with Defender, OneDrive,
enterprise Git credentials, proxies or network storage. Keep those host effects separate.
No complete-Story token saving is asserted. No remote synchronization, approval, tests or
authority check has been made asynchronous or skipped.

## Story creation performance

For the subsequent isolated-checkout and index-I/O improvements used by VS Code, see
[Isolated Story creation performance](../ISOLATED-STORY-PERFORMANCE.md). The results below describe
the earlier optimization stage.

This change optimizes creation, not just the intake catalog or CLI startup. It applies to the
CLI used by Copilot and VS Code's isolated Story-start path. It does not change phase policies,
automatically run tests, defer publication, or claim that readiness means tests passed.

### story creation performance — Measured costs and fixes

The initial local profile used 131 Git launches for a normal start and 158 for an isolated start.
Much of the transaction was Git work, configuration loading, workflow snapshot creation and
publication. The readiness projection itself took less than 1 ms in this fixture; there were no
dependency-install or baseline-test commands to remove.

- Configuration loading repeatedly checked shared templates for different workflows. It now
  validates each unique path once per load, with at most four independent filesystem reads in
  flight. All readers settle before refusal and failures retain catalog order. The fixture avoids
  162 repeated template checks per normal creation and 216 per isolated creation. Paths are checked
  again on the next load: no positive result survives a write, checkout or CLI invocation.
- Checkout used separate Git processes for the local destination, tracked destination, remote base
  and local base. One fresh bounded ref batch replaces these probes. Exact names, refreshed-remote
  preference, existing-branch handling, packed refs and exact-commit refusals are retained.
- A clean ordinary launch performed the same complete working-tree scan twice, with no intervening
  asynchronous work. It now performs it once. An isolated child still checks its own checkout;
  publication still independently validates the candidate and unrelated changes.
- The legacy base path re-read governance after loading and validating that exact immutable
  configuration. It now consumes the verified result, while retaining the later live-fetch/base
  comparison. A changed base still refuses. Shared approved configuration keeps precedence.

No mutation approval or remote authority is cached to get these savings. Fetch, push preflight,
create-only publication, durable recovery journals, secret scanning and final push remain intact.

### story creation performance — Reproduce a before/after comparison

```sh
node scripts/story-creation-benchmark.mjs --samples=5 --files=10000 --control-ref=9610a654b72477977d8dd90d71da4147dd89c89c
```

Both variants use the same coarse installed packaging, stock feature workflow, repository fixture
and local bare remote. The control replaces only the changed runtime modules with their bytes
from the named commit before building its bundle. The script records that exact list, alternates
candidate/control order, uses separate initially empty compile caches, and verifies that each
created Story's local tip exactly matches its published remote tip. It exercises ordinary creation
and the isolated-worktree path used by VS Code. Temporary repositories and caches are removed in
`finally`. There are no model calls or public-remote pushes.

Use `--layout=source` without `--control-ref` for a source-only diagnostic. The existing
`SINGULARITY_FLOW_SUBPROCESS_PROBE=1` and `SINGULARITY_FLOW_SUBPROCESS_TRACE` switches expose
per-command counts and call sites. Their raw diagnostics may contain fixture paths; the JSON
report retains only operation names. `counters.git.spawns` includes the complete instrumented Git
boundary; `localTraceGitProcesses` is only the subset visible in Git's local trace environment.
Timing spans overlap and must not be added together.

### story creation performance — Local results (2026-10-16)

[Raw paired results](../../benchmarks/story-creation/local-macos.json): macOS arm64, Node v25.5.0,
10,000 small tracked source files, five samples per variant per mode. The OS cache was not flushed.

| Complete creation, including publication | Control median | Candidate median |
| --- | ---: | ---: |
| Working checkout | 1,433 ms | 1,353 ms |
| Isolated worktree (VS Code path) | 2,647 ms | 2,666 ms |
| Git launches, working checkout | 131 | 121 |
| Git launches, isolated worktree | 158 | 149 |

Ordinary creation improves about 5.6% on this host. Isolated creation is effectively unchanged
(0.7% slower in these samples), despite fewer launches and template checks; materializing the
checkout and the synchronous publication still dominate. These are not complete-Story or token
savings. An earlier run overlapped the test suite and was discarded, rather than reporting its
inflated apparent gains. The raw results above come from the subsequent quiet run.

For a real slow Story start, add `--timings` to the same reviewed start command. The existing
VS Code progress stream is retained, so long work is distinct from an unresponsive UI.

### story creation performance — Qualification limits

Measurements are local macOS results, not native Windows qualification. The same portable fixes
remove expensive Git process launches and repeated file opens on Windows, but antivirus,
PowerShell/tool startup, enterprise Git authentication and network transfer remain host-dependent.
Do not translate the removed launch count into a promised number of seconds or claim that a
six-minute Windows start is resolved without inspecting that host's timing record.

The test coverage includes moved bases and seed refs, remote retargeting, missing/malformed
approved configuration, dirty worktrees, receipt fallbacks, sparse checkout, publication failures,
and durable recovery. Template deletion or symlink replacement after a successful load is refused
on the next load. The CLI and VS Code bundle budgets remain enforced without increasing them.

## Large Windows isolated Story creation

### large windows story performance — What the 46-second report actually measured

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

### large windows story performance — Change

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

### large windows story performance — Qualification

The [initial three-pair Windows report](../../benchmarks/story-creation/large-projection-windows.json)
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

The [final exact-source Windows smoke](../../benchmarks/story-creation/large-projection-windows-final.json)
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

The [intermediate exact-commit-policy report](../../benchmarks/story-creation/large-projection-windows-policy.json)
binds source `e45a98fd601b3370f5ce6b10fa9b6092cef02917` to CI `38957530274`.
Its 10,000-file pair measures 25,865 ms control and 19,451 ms candidate. Its three 1,000-file
pairs measure 16,912 ms control median (14,750–19,903) and 14,408 ms candidate median
(14,360–15,465), all exact tips and each candidate faster. This is a pre-plumbing measurement,
not a final-source performance distribution; its overall CI run still failed the old fixtures.

A subsequent [plumbing paired attempt](../../benchmarks/story-creation/large-projection-windows-setup-failure.json),
CI `38958491802`, passes its regression job but fails in fixture `git add .` after the existing
120-second setup limit. That is before the failed sample's Story invocation, not an observed
Story timeout; no timing report survived this run. The final exact-source smoke above succeeds
independently. The setup timeout was not enlarged and no product deadline or Git policy relaxed.
The production tree never contains the temporary hosted workflow.

The [three-pair Mac report](../../benchmarks/story-creation/large-projection-macos.json) binds
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

### large windows story performance — Main integration

The final pre-merge fetch still resolves main to
`3fd3db0b0ba1dbfdeb74ffa72b614441212cae35`, the fresh-clone baseline. No intervening upstream
work is overwritten. Production integration is a fast-forward containing no hosted-workflow files;
temporary native-qualification refs are removed after their completed runs and reports are retained.

### large windows story performance — Reproduce

```sh
node scripts/story-creation-benchmark.mjs --mode=isolated --fresh=true --configuration=approved --samples=3 --files=10000 --control-ref=3fd3db0b0ba1dbfdeb74ffa72b614441212cae35 --out=large.json
```

Candidate/control alternate in fresh repositories and private compile-cache directories using
the same installed packaging. Every run verifies the exact remote Story tip. Models and tests
are not run during intake. The remote is local bare Git; OS caches are not flushed. These are
native CLI-path measurements, not office-laptop antivirus/network or native VS Code paint timings.

## Bound phase and next-step performance

### phase next performance — Changes

- A bounded Story-local history read supplies immutable first-add/touch observations together.
  Merge and rename/copy histories retain the original exact-path traversal. Missing objects,
  changed/restored records, shallow boundaries and invalid Git output remain errors.
- Immutable tree metadata is acquired once per exact commit/visibility in a verification scope,
  then projected to each requested path. Oversized or unavailable optional inventories fall back
  to the original bounded reader; they never become empty successful trees.
- Accepted snapshots and strict Story loading share rejection-audit verification through the
  existing routine verification cache. Exact raw/normalized inputs have four private slots per
  provenance kind, preventing repeated eviction. Explicit refresh and Git/index/config/object
  changes still invalidate them. The configurable 30-minute default is unchanged.
- Phase entry validates syntax through a narrow leaf and resolves the current binding before
  importing authoring/recovery services. Read-only next guidance imports only the binding owner.
  Constructing a grounding-record path no longer loads source-review/input readers.
- The parent-owned VS Code worker accepts the closed `nextsteps [ID] --for-agent --json` form.
  It uses the canonical binding, pause, guidance and output-presentation owners. Each request
  resets mutable observations. Background preparation loads reset owners before reporting ready.
  Authoring, composition, review, tests, publication and approvals remain outside this worker.
  The VS Code tool-policy gateway retains its original fresh verification path and does not
  embed the CLI batching graph; existing bundle limits are unchanged.
- Composing a skill phase passes the accepted definition into input collection. The prior missing
  handoff was a correctness failure, not a performance result.

No persistent worker endpoint is exposed to arbitrary shell processes. Native Copilot shell
commands still use the CLI; worker results measure SFlow-owned integration requests. No human
approval, application edit, model invocation, remote fetch or Story advancement is benchmarked.

### phase next performance — Reproduction

```sh
node scripts/phase-next-paired-benchmark.mjs --baseline-engine=/absolute/baseline --samples=4 --output=/absolute/results.json
```

Four alternating A/B and B/A pairs use independent local clones and installed bundles. Legacy
fixtures have 20 source files; pinned/amended fixtures have 1,000 files, 50 additional commits and
eight artifacts. Every successful entry must have a real current-phase agent binding; composed
cases must deliver context. Setup, cloning, builds and private session binding are outside timing.

Cold means a fresh Node process, empty private V8 cache and no accepted-provenance receipts.
Warm means a new Node process with those caches populated; the OS page cache is not flushed.
The low-level cross-process Git fact store is disabled to isolate these owners. Timings retain
each sample, Git counters, coarse stages and named spans. Nested spans are not additive.
Summaries use the upper observed median, not an interpolated average or a confidence bound.

Worker-start, repeated-worker and definition-prewarmed requests are reported separately. The
prewarmed case uses an independent fresh clone and V8 cache, not the repeated request's receipts.
Worker preparation does no repository reads; its measured cost is reported separately and is
excluded only from the explicitly prewarmed request row. Raw agent JSON retains complete binding
fields for measurement; default bounded presentation is covered by the worker parity regressions.
The baseline's amended skill composition refuses with the missing-definition error; that row has
no percentage gain. Native Windows results require `runtime.platform=win32`.

Qualification targets portable entry, cache, worker, snapshot/amendment, test-command epoch and
published-contract regressions. It is not a full-suite or 1.0 release qualification. The unmodified
POSIX terminal reattestation ceremony is outside the Windows performance selection; release skip
policy and human-terminal authorization are unchanged. Native checkout conversion is enabled;
fixture authority files retain exact bytes and recovery assertions compare Git-rendered bytes.

### phase next performance — Native results

Baseline: `4786580ac14b86b646990a44cf0e8c377d6b3097`. Final runtime candidate:
`148e4394a6baa7bba5a7f99645c6da22fb203c8d`. Both measured source checkouts were clean;
the harness records these identities before setup and rejects source changes before completion.
The following tables report milliseconds, baseline → candidate. Positive reductions mean faster;
negative reductions mean slower. Four pairs are a small sample, not a statistical guarantee.

#### phase next performance — macOS

Native hosted ARM64, Node 22.23.2, qualification run `39456556959`:

| Story | Request | Cold ms | Reduction % | Warm ms | Reduction % | Cold Git spawns | Warm Git spawns |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Legacy | nextsteps | 478.84 → 495.42 | -3.5 | 277.04 → 274.61 | 0.9 | 6 → 6 | 6 → 6 |
| Legacy | phase entry | 641.61 → 618.78 | 3.6 | 443.64 → 436.25 | 1.7 | 26 → 26 | 26 → 26 |
| Legacy | composed entry | 1023.30 → 962.51 | 5.9 | 593.97 → 591.87 | 0.4 | 32 → 32 | 36 → 36 |
| Pinned | nextsteps | 591.57 → 604.11 | -2.1 | 286.92 → 280.86 | 2.1 | 22 → 21 | 9 → 9 |
| Pinned | phase entry | 707.75 → 757.58 | -7.0 | 479.92 → 471.26 | 1.8 | 38 → 37 | 27 → 27 |
| Pinned | composed entry | 1138.81 → 1132.42 | 0.6 | 662.94 → 662.12 | 0.1 | 44 → 43 | 37 → 37 |
| Amended | nextsteps | 800.24 → 676.54 | 15.5 | 340.37 → 262.17 | 23.0 | 59 → 39 | 20 → 10 |
| Amended | phase entry | 976.59 → 897.41 | 8.1 | 795.08 → 676.18 | 15.0 | 82 → 61 | 82 → 55 |
| Amended | composed entry | refused → 1286.23 | N/A | refused → 828.73 | N/A | 94 → 67 | 85 → 65 |

The amended composed baseline fails with `Skill phase 'threat-model' inputs require the accepted
Story definition.` The candidate completes with admitted context. Refusal latency is not useful
work, so neither it nor the reduced Git count establishes a speedup for that row.

An independent run on the development Mac (ARM64, Node 22.14.0), with the same final runtime and
four amended-Story pairs, measured nextsteps at 609.20 → 535.06 ms cold (12.2%) and
258.87 → 197.00 ms warm (23.9%); phase entry at 762.70 → 701.46 ms cold (8.0%) and
619.37 → 490.87 ms warm (20.7%). This replicates the amended-Story improvement, not a universal
gain across ordinary Stories.

#### phase next performance — Windows

Native hosted x64, Node 22.23.3, qualification run `39456556959`:

| Story | Request | Cold ms | Reduction % | Warm ms | Reduction % | Cold Git spawns | Warm Git spawns |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Legacy | nextsteps | 1168.65 → 1165.74 | 0.2 | 760.11 → 765.14 | -0.7 | 6 → 6 | 6 → 6 |
| Legacy | phase entry | 1924.00 → 1893.91 | 1.6 | 1519.05 → 1507.33 | 0.8 | 26 → 26 | 26 → 26 |
| Legacy | composed entry | 4454.90 → 3927.55 | 11.8 | 2265.56 → 2156.35 | 4.8 | 32 → 32 | 36 → 36 |
| Pinned | nextsteps | 1900.02 → 1880.78 | 1.0 | 970.68 → 970.00 | 0.1 | 22 → 21 | 9 → 9 |
| Pinned | phase entry | 2886.44 → 2890.66 | -0.1 | 2100.93 → 2084.34 | 0.8 | 38 → 37 | 27 → 27 |
| Pinned | composed entry | 4860.72 → 4841.91 | 0.4 | 3034.31 → 3011.53 | 0.8 | 44 → 43 | 37 → 37 |
| Amended | nextsteps | 3168.75 → 2558.93 | 19.2 | 1355.06 → 892.06 | 34.2 | 59 → 39 | 20 → 10 |
| Amended | phase entry | 4727.82 → 4374.90 | 7.5 | 4292.85 → 3440.58 | 19.9 | 82 → 61 | 82 → 55 |
| Amended | composed entry | refused → 5961.84 | N/A | refused → 3872.58 | N/A | 94 → 67 | 85 → 65 |

The legacy composed cold gain was only 1.6% in the earlier native run, versus 11.8% here, with
unchanged Git counts; do not treat that noisy row as a repeatable 11.8% improvement. Amended
nextsteps and phase-entry improvements reproduced in both native runs and the development Mac.

#### phase next performance — Owned nextsteps worker

Candidate-only observed medians, rounded to whole milliseconds. These are separate transport
states, not an A/B speedup claim. "Prepared first" still starts with cold repository provenance.

| Host | Story | Worker start + first request | Repeated worker request | Prepared first request | Separate background preparation |
| --- | --- | ---: | ---: | ---: | ---: |
| macOS | Legacy | 467 | 79 | 128 | 333 |
| macOS | Pinned | 542 | 83 | 219 | 316 |
| macOS | Amended | 678 | 80 | 350 | 316 |
| Windows | Legacy | 1098 | 267 | 423 | 670 |
| Windows | Pinned | 1741 | 468 | 1066 | 669 |
| Windows | Amended | 2642 | 534 | 1946 | 688 |

Prewarming shifts definition startup before the user's request only when background preparation
has finished. Adding preparation and first-request time gives approximately the original cold
worker cost; hiding preparation is not an end-to-end saving. Repeated worker requests benefit
from loaded modules but still reset mutable state and observe the current session/repository.

#### phase next performance — Interpretation

Legacy and ordinary pinned CLI paths remain mostly flat; some cold rows are slower. The clear
improvement is amended provenance: nextsteps removes 20 cold / 10 warm Git spawns, and phase entry
removes 21 cold / 27 warm spawns in this corpus. Binding-first entry avoids the full authoring
closure for missing/paused bindings; a ready authoring request still needs its original services.
No readiness, hash, ancestry, source-review, policy or mutation gate was removed to obtain savings.

Optional combined inventories never hydrate a remote object. A fresh final-binding scope bypasses
both an enclosing tree inventory and a history batch, returning to the original exact Git owners.

### phase next performance — Qualification record

Native run `39454606512` tested runtime `307471f5` on macOS and Windows: 45 phase-entry/recovery
tests plus 173 integrity regressions on each host (218 passed per host; zero failed, cancelled,
skipped or todo). Both hosts also passed product validation, VS Code typechecking/build and the
complete paired benchmark. The final runtime then added two narrow hardening changes:
`GIT_NO_LAZY_FETCH=1` for optional history acquisition and explicit fresh-scope bypass of enclosing
provenance batches. Run `39456556959` rechecked these changes at `148e4394` with 56 targeted
regressions on each host, all passing with zero skipped tests; product validation, typecheck and
build also passed on both hosts. The measurements above use this final runtime, not an earlier
development candidate. Subsequent changes to this report are documentation only.

The initial qualification exposed fixture assumptions about LF-only recovery bytes, conversion
of immutable template bytes and delayed Windows file-handle release. Those were corrected using
Git-filtered expected bytes, fixture attributes and bounded cleanup retries. Production recovery
and review authorization were not weakened. Existing lifecycle and VS Code byte/module budgets
were retained and passed; no ceiling was raised to accommodate the implementation.

## Publication context and first-write qualification

Baseline: `b440b0a6` from main. The implementation keeps the same locked lifecycle transaction,
recovery journal, secret/environment admission, Candidate verifier and final compare-and-swap.
No application tests, human approval, independent review or remote push is skipped by this work.

### publication performance — Changes

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

### publication performance — Reproduce

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

### publication performance — Measured Mac results

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

The final integrated writer's static installed closure is 5,281,209 bytes, versus 7,161,598 bytes for
the baseline chunk containing the former Story store (about 26% less). The complete deployment
has 21 coarse files versus 20. Reader/catalog parse budgets and the partial-deployment fallback
remain enforced. A smaller import graph alone does not imply the same elapsed-time saving.

Hosted Mac measurement run `39201529449` checked one fresh review binding and three independent
input loads in every measured before/after publication. Optimized small runs used 100 Git
processes cold / 89 warm, and larger runs 106 cold / 95 warm. Each retained one immutable-tree
read hit; renamed/copied-resource diffs and the mutable ref checks still executed independently.

### publication performance — Measured Windows results

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

### publication performance — Windows correctness discovered during qualification

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

### publication performance — Latest-main integration and qualification

Integrated main through `12899b26` before the final merge. The publication measurements above
remain the frozen `b440b0a6` versus `1078bf60` comparison, not a newly measured speedup against
the later main. The later changes retain the same benchmarked review-retention transaction path.

The latest-main source graph initially exposed an eager-import budget regression. Optional human
document review rendering is now lazy in approval and phase lifecycle commands, and the prospective
test-command token shares its existing contract owner rather than adding another eager module.
Approval reaches 446 local files and phase lifecycle 453, both below the unchanged 455-file ceiling.
No import budget or permission gate was relaxed to accept this work.

- Final latest-main local Mac regression: 480 passed, zero failed or skipped, on Node 22.14.0.
  TypeScript-importing tests use `--experimental-strip-types`, required by this older Node 22 build.
- Final product checks: 2,812 passed. CLI bundle build, VS Code typechecking and VS Code build passed.
- Native macOS run `39204947590`, before the latest-main integration, passed all 415 cases and its
  product/build checks. The corrected Windows spot checks in that run passed, including native
  short/long test-path handling and actual private-ACL validation; the POSIX hook case is inapplicable.
- The new native qualification/remeasurement run `39205514283` was refused before executing any
  step because GitHub Actions reported an account payment/spending-limit issue. The user explicitly
  requested merging without that run. Final latest-main Windows qualification and remeasurement are
  therefore waived, not reported as successful. The earlier native measurement jobs completed and
  their raw results remain retained separately.

### publication performance — Reviewed boundary moves

The frozen Git inventory records the unchanged history/show sites moving from `state.mjs` into
`story-policy-anchor.mjs`, and the existing Candidate executor moving behind the closed immutable
read wrapper. Benchmark launch sites remain bounded Node processes against disposable fixtures;
the additional `rev-parse HEAD` assertion proves that measured publication really committed.
No new registered process owner or arbitrary Git capability is granted. Lifecycle vocabulary
forwarding registrations follow the exact Story function/class moves; Initiative's existing
wrapper and runtime event validation remain unchanged.

## Shared-read performance

This change removes duplicate work from session read projections. It introduces no persistent
authorization cache and does not change the existing advisory-cache interval or mutation gates.

### shared read performance — Findings and changes

- `session current` loaded the complete configuration twice: once for accounting and once for
  discovery. This repeated secured source reads, YAML parsing, agent scans, template checks and
  definition validation. Closed current/status/context reads now share one invocation scope;
  accounting projects only its logging/harness preferences from the same secured source.
- A pinned/amended current session uses the accepted Story loader rather than today's unrelated
  live agent catalog. The context broker preserves its guidance-only read contract and retains
  the exact verified interpretation when amended/custom phases require it. Legacy live policy
  is still fully validated; malformed retained closures are not accepted as current configuration.
- The current-session response already contained its verified checkout and revision, but building
  its execution-context projection independently rediscovered root, paths, object format, bare
  status, HEAD and branch. The projection now receives the revision that its owner just captured.
  It remains advisory and cannot authorize a write.
- Session file readers repeatedly asked for the private Git directory after root discovery had
  already proved it. Only explicit read scopes reuse that directory. Outside them, the original
  fresh Git query and error fallback remain unchanged.
- Read-only session discovery imported the full state-store gateway just for a configuration
  alias and pure Work ID validation. Those now use their canonical read/pure owners, retaining the
  old exports. Configuration location declarations live with the existing asset policy rather
  than importing bootstrap/clone code to obtain two strings.
- The current-session projection is moved, not reimplemented, into a narrow handler. Closed forms
  load it directly; unknown/effectful options retain the existing adapter and refusal handling.
  Its source closure fell from 429 local files / about 8.51 MB to 208 / about 3.77 MB. This static
  reduction alone is not an elapsed-time claim. Existing root and bundle ceilings remain enforced.

Phase authoring, publication, approval, session attachment/takeover and explicit refresh do not
inherit this new reuse policy. Failed reads do not become empty successes, later invocations see
edits, and separate/concurrent read scopes do not share their mutable observations.

### shared read performance — Measurement protocol

```sh
node scripts/shared-read-paired-benchmark.mjs --baseline-engine=/absolute/baseline --samples=4 --output=/absolute/results.json
```

Both engines are built into the installed cold-layout bundle. Paired A/B and B/A requests use
independent local clones and compile-cache directories. Each first request has no prior private
provenance/advisory receipt; its immediate repeat uses a new Node process with the same caches.
The OS file cache is not flushed. This is not a persistent-worker benchmark.
Summaries use the upper observed median (sorted sample at index `floor(n / 2)`), without
interpolation. Four-pair gains are directional measurements, not confidence bounds or guarantees.

The legacy corpus has 20 source files. Pinned and amended corpora have 1,000 source files,
50 additional history commits and eight artifacts. Successful pairs check returned binding parity.
The baseline refuses current/context reads for the amended fixture with `AGENT_PHASE_UNKNOWN`;
that exact refusal is retained, and the successful candidate's Story identity is checked. Those
rows are correctness repairs, not speed comparisons, and have no percentage gain.
Setup, builds and cloning are untimed. Measured reads use no model or remote network operations;
the results do not estimate complete Story or native Copilot round-trip savings.

Reports retain every sample, physical Git spawns, command stages, secured configuration source
reads and catalog counters. Those file counters cover their instrumented boundaries, not all
filesystem access. Native Windows claims require a report whose platform is `win32`.

### shared read performance — Qualification

The local Apple Silicon Mac comparison uses clean baseline `322e75e3` and candidate `112b954f`,
Node 22.14.0 and four alternating pairs per row. Values are elapsed milliseconds; positive gains
mean faster. These are installed CLI requests, not native Copilot or complete-Story latency.

| Story / request | Cold before → after | Cold gain | Warm before → after | Warm gain |
| --- | ---: | ---: | ---: | ---: |
| Legacy / session current | 343.74 → 316.78 | 7.8% | 205.19 → 174.52 | 14.9% |
| Legacy / session status | 319.29 → 309.17 | 3.2% | 178.75 → 168.40 | 5.8% |
| Legacy / session context | 314.83 → 302.38 | 4.0% | 174.75 → 163.38 | 6.5% |
| Pinned / session current | 436.89 → 389.61 | 10.8% | 223.50 → 177.59 | 20.5% |
| Pinned / session status | 397.91 → 381.54 | 4.1% | 186.29 → 169.81 | 8.8% |
| Pinned / session context | 324.92 → 293.91 | 9.5% | 185.58 → 153.48 | 17.3% |
| Amended / session status | 560.71 → 543.67 | 3.0% | 232.49 → 216.31 | 7.0% |

For `session current`, physical Git children fell from 12 to 6 on legacy and warm pinned reads,
and from 25 to 19 on cold pinned reads. Status dropped one Git child. Context retained four Git
children on the ordinary pinned/legacy fixtures; its gains are from reduced loading/validation,
not fewer Git commands. Legacy source reads/parses fell from two to one for current and three to
one for status/context. Full legacy catalog scans fell from two/three to one; pinned current
uses its accepted closure instead of scanning the unrelated live agent catalog.

The `phase enter` and `nextsteps` controls were largely flat: ordinary legacy/pinned measurements
varied by less than 1%. Amended cold phase entry was 6% slower in this small local sample, with
identical Git counts and a 0.4% warm difference; no phase-entry speedup is claimed. Amended
current/context changed from the known baseline refusal to successful, correctly bound responses
and are intentionally excluded from percentage comparisons.

The native Windows x64 comparison uses the same clean revisions, Node 22.23.3 and four pairs.

| Story / request | Cold before → after | Cold gain | Warm before → after | Warm gain |
| --- | ---: | ---: | ---: | ---: |
| Legacy / session current | 1636.53 → 1265.94 | 22.6% | 996.90 → 774.79 | 22.3% |
| Legacy / session status | 948.70 → 818.02 | 13.8% | 624.75 → 557.69 | 10.7% |
| Legacy / session context | 903.57 → 809.74 | 10.4% | 602.11 → 606.85 | -0.8% |
| Pinned / session current | 1893.45 → 1534.02 | 19.0% | 1016.72 → 706.94 | 30.5% |
| Pinned / session status | 1407.79 → 1279.90 | 9.1% | 697.89 → 600.60 | 13.9% |
| Pinned / session context | 920.81 → 733.56 | 20.3% | 681.46 → 549.52 | 19.4% |
| Amended / session status | 2757.54 → 2655.30 | 3.7% | 1092.36 → 1004.70 | 8.0% |

Windows Git-spawn counts match the Mac counts above. The Windows `phase enter` controls varied
from -3.5% to +2.3%, while `nextsteps` varied from -6.3% to +14.5%, with unchanged Git counts.
Those controls and the one flat/slightly slower warm context row do not support a universal
command-speed claim. The earlier Windows baseline/candidate run also improved pinned current by
15.9% cold and 29.6% warm, before the latest-main integration. None of the runs are an OS cold-boot
or native Copilot round-trip measurement.

Qualification also repaired portable test fixtures: module-name assertions normalize native path
separators, exact-byte sync/drift fixtures pin LF checkout bytes, and the unsafe-cache-ancestor
case exercises a Windows junction rather than skipping. The workspace-attach rail now runs on
Windows as well. Only its unavailable-cloud-file observation/download failure is injected there;
the actual detector, CLI, Git attachment and recovery execute. This is not live OneDrive-provider
qualification. The existing release reporter still refuses skipped, cancelled and todo tests.

The paired runtime reports were frozen at `112b954f` after integrating `322e75e3`; subsequent
commits change portable test fixtures and this report, not production modules or bundle logic.
Native benchmark run `39438231290` retains the raw samples; its preliminary validation failures
are not a passing qualification. The corrected full-Story run `39441659750` passes on both hosts
with checkout conversion enabled, one test and zero skips per host. The final targeted native
regression run `39443693511` passes 100 tests on each host with zero failures, cancellations, skips
or todo cases, and passes product validation, VS Code typechecking and the VS Code build on both.
Local extended session/configuration tests also pass 99 cases without skips. Source/bundle budget
and parity guards remain enabled. No full-suite or 1.0 release qualification is implied by these
scoped results.

## Source review performance

`/sf-review-source` still performs independent semantic review. This optimization changes only
its deterministic Node/Git reads; it does not remove citation checking, source coverage, reviewer
independence, human decisions or the last fresh retention binding check.

### source review performance — Read model

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

### source review performance — Reproduction and limits

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

### source review performance — Cold review fast path

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

### source review performance — Local Mac source-mode measurements

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

### source review performance — Local Mac installed-bundle measurements

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

### source review performance — Native Windows installed-bundle measurements

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

### source review performance — Qualification record

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

### source review performance — Follow-on cold-path measurements

The follow-on baseline is `61538bd8` (already containing the earlier snapshot/batching work),
not `8dcb3a27`. Six alternating A/B and B/A pairs per profile use the installed bundle and an
independent empty compile cache for every fixture. Values are medians in milliseconds; sequence
medians are computed per complete run, not by summing the individual step medians.

| Host / profile | First context before → after | Sequence before → after | Sequence gain |
| --- | ---: | ---: | ---: |
| This Mac / small | 675 → 593.5 | 3,151 → 2,692.5 | 15% |
| This Mac / larger | 633 → 544.5 | 2,781 → 2,401.5 | 14% |
| Hosted macOS / small | 543.5 → 470.5 | 2,286 → 1,985 | 13% |
| Hosted macOS / larger | 530.5 → 471 | 2,328.5 → 1,965 | 16% |
| Hosted Windows / small | 2,071.5 → 1,814.5 | 10,900 → 9,438.5 | 13% |
| Hosted Windows / larger | 2,424.5 → 2,140 | 12,496 → 11,620.5 | 7% |

These six-pair measurements qualify the cold-read refactor before the final singleton metadata
refinement. That refinement restores the existing individual cache path for one or two requests,
avoiding the group's second object-store scan; larger groups still coalesce and revalidate.
Its final smoke measurements and affected tests are recorded separately below. Do not present
these six-pair figures as a new measurement of that last refinement.

The review read's static bundle closure fell from 9,857,233 to 4,214,538 bytes, while the installed
envelope stayed at twenty files. In the Windows small profile, cold module loading fell from a
median 318 to 104 ms and accounting preparation from 407 to 113 ms. Definition loads fell from
two to one; logging no longer scans the agent catalog or checks 57 templates. Timed spans may
overlap and must not be added to predict elapsed time.

Retention is not made uniformly faster by this change: the larger Windows profile was roughly
flat (5,752 → 5,817 ms) and still dominates total time. Git children fell only from 93 to 92 for
small retention, and 99 to 98 for larger retention. Initial, fresh-transaction and post-commit
input loads remain separate, and every retained benchmark review performed one fresh binding
check. Conservative Windows cache admission still applies; no timestamp-race rule was relaxed.

Run `39188491990` supplies the hosted six-pair data; raw observations are retained as qualification
artifacts. Its benchmark steps and four reader/retention tests passed on both hosts; its later
product check found the new benchmark launch site missing from the frozen process inventory.
That exact launch was reviewed and recorded, without widening the registered Git owners.
An earlier qualification attempt also used an inappropriate synthetic Git name that made the
privacy audit flag the product name; only the CI fixture identity was corrected.

Final broad platform run `39189018604` passed on both hosts: 247 tests on macOS and 246 on
Windows, with one existing privilege-dependent symlink case skipped on Windows and exercised
on macOS. Both hosts passed 2,775 product checks, the CLI build, VS Code typechecking and build,
including generated-output privacy checks. A separate local broader run passed all 330 tests,
including publication faults. No validation or approval policy was weakened to obtain these results.

#### source review performance — Final singleton-cache refinement

Run `39191782059` qualified `d18afdc6` on both hosts: all 60 affected cache, invalidation,
fresh-binding and review tests passed on each, together with 2,775 product checks, CLI builds,
VS Code typechecking/builds and generated-output checks. Every optimized retention observation
still had three independent input loads and exactly one fresh binding check.

Its two-pair balanced smoke is deliberately reported separately from the six-pair measurements:

| Host / profile | First context before → after ms | Sequence before → after ms |
| --- | ---: | ---: |
| Hosted macOS / small | 539.5 → 487 | 2,256 → 1,916 |
| Hosted macOS / larger | 531 → 462 | 2,316 → 1,954 |
| Hosted Windows / small | 1,907 → 1,814.5 | 10,092.5 → 8,989 |
| Hosted Windows / larger | 2,107 → 1,817 | 11,413.5 → 14,524.5 |

The last row is a regression in this smoke, not a speedup. Its two optimized retention samples
were 5,250 and 11,519 ms versus 4,934 and 5,147 ms before; the slow observation also had higher
Git service time and publication admission/candidate/commit time. The measurements do not
establish whether the change or host variability caused it, so the larger Windows profile was
repeated with six balanced pairs before integration. Startup improvements alone cannot justify
a claim that complete review retention is faster.

The six-pair repeat, run `39192673121`, also passed all 60 affected tests, 2,775 product checks,
CLI builds and VS Code typechecking/builds. Its larger Windows medians were:

| Step | Before ms | After ms |
| --- | ---: | ---: |
| First context, empty compile cache | 3,219.5 | 2,158.5 |
| Repeated context | 1,994.5 | 1,600 |
| Staging | 1,603 | 1,244 |
| Report check | 1,401 | 1,026 |
| Retention, including fresh binding | 6,942 | 6,277 |
| First status after retention | 1,941.5 | 1,649.5 |
| Complete measured sequence | 15,162 | 12,654.5 |

The sequence improved 17% in this repeat, with fresh binding retained in all six optimized runs.
Absolute host timings varied substantially between qualification runs; optimized retention still
ranged from 5,576 to 9,635 ms, versus 6,024 to 11,300 ms before. This supports the read/startup
optimization, not a fixed latency promise or a claim that publication is solved. The benchmark
excludes Copilot model time, shell transport and network pushes; no office laptop was measured.

## Story creation: shared capture and background configuration preparation

### story start context performance — Recorded qualification — 2026-10-21

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
runtime versions and qualification run IDs are in [the numeric results](../story-start-context-results.json).
The additional corrected-probe/default-guard checks are separate samples, not replacements for
these primary medians. Prepared request time excludes preparation in the table; the numeric
results also retain the complete charged total, which can be higher.

The complete modified-area suite passed **260 cases with no failures/skips** on this Mac and native
Mac CI. The corresponding Windows run had 253 passes, six existing POSIX-only skips, and one
Windows path-separator defect in the audit test. That test was corrected without changing runtime
behavior; the **82-case Windows follow-up passed with no failures/skips**, including the corrected
audit. Checks, VS Code typechecking and builds passed on both hosts. This is targeted performance
qualification, not full release qualification.

### story start context performance — Implementation

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

### story start context performance — Measurement protocol

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

### story start context performance — Reproduce

Use an otherwise idle host and the same Node/Git installation for both variants. Substitute the
full baseline OID for `BASELINE`:

```sh
node scripts/story-creation-benchmark.mjs --samples=3 --files=1000 --mode=isolated --configuration=approved --fresh=true --control-ref=BASELINE --out=story-cold.json
node scripts/story-creation-benchmark.mjs --samples=3 --files=1000 --mode=isolated --configuration=approved --fresh=true --prewarm=all --control-ref=BASELINE --out=story-prewarmed.json
node scripts/story-creation-benchmark.mjs --samples=3 --files=1000 --mode=isolated --configuration=approved --fresh=false --prewarm=all --control-ref=BASELINE --out=story-established.json
node scripts/intake-creation-benchmark.mjs --samples=3 --files=1000 --control-ref=BASELINE --out=intake.json
node scripts/intake-creation-benchmark.mjs --samples=3 --files=1000 --configuration-preparation=on --control-ref=BASELINE --out=intake-experimental.json
```

### story start context performance — Safety coverage

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

## Workspace creation and Story intake qualification

For the subsequent shared-capture, publication batching, Windows ACL and selected-configuration
work, see [Story creation context qualification](performance-qualification.md#story-creation-shared-capture-and-background-configuration-preparation). Its matched
baseline/candidate cohort is separate from the historical measurements below.

### workspace creation performance — Recorded results — 2026-10-21

Both native qualification jobs passed 65 modified-area tests with zero failures/skips, plus one
resumed-workspace case each. The copied-workspace regression passed separately on both hosts. The
earlier Windows workspace/clone-recovery step passed all 141 cases; subsequent FOS, ACL, worker and
resume changes were covered by the final targeted runs. Checks, VS Code typechecking and builds
passed. This is not full release qualification.

Installed-build medians in seconds below compare baseline to candidate. Workspace/Story rows use
three samples per variant/mode; 10k and intake rows use two (the mean of the two middle values).
The baseline is `a0fc9d19`; the qualified runtime is `5d73cfdb`. Final test-only follow-ups do not
change runtime behavior. Native qualification/measurement run: `39545312394`; final copy check:
`39545814760`. Node and Git versions, every sample and separately charged prewarm costs are in
[the raw results](../workspace-creation-results.json).

| Request | Native Mac cold | Native Mac prewarmed | Windows cold | Windows prewarmed |
| --- | --- | --- | --- | --- |
| Workspace, 1k files | 2.823 → 2.046 | 2.658 → 1.868 | 6.295 → 5.313 | 6.028 → 5.139 |
| Workspace, 10k files | 3.988 → 3.715 | 4.059 → 3.165 | 12.931 → 10.136 | 12.563 → 9.637 |
| Isolated Story start | 6.839 → 7.062 | 6.120 → 5.845 | 18.405 → 18.124 | 20.254 → 24.458 |
| Readiness + isolated start | 8.164 → 9.130 | 8.362 → 7.781 | 26.481 → 29.930 | 29.765 → 30.736 |

Workspace creation consistently improved in this cohort: approximately 16% cold on Windows for
1k files and 22% for 10k files. Git launches fell from 71 to 62 on both native runners. On the local
Mac, the 1k-file medians were 1.196 → 0.943 seconds cold and 1.055 → 0.909 prewarmed, with Git calls
73 → 64. Absolute counts/times differ across hosts, so compare variants within a host rather than
pooling different host environments.

Story/intake latency is **not consistently improved**. Isolated-start Git calls fell 225 → 219 on
native Mac and 211 → 205 on Windows; combined intake calls fell 298 → 293 and 267 → 262 respectively.
Nevertheless some medians worsened, notably Windows prewarmed Story start (+20.8%). Its candidate
range (18.566–25.822 seconds) overlaps the control range (18.412–25.961 seconds); this small, variable
cohort cannot establish a causal regression or a speedup. Do not market general Story latency
savings from these measurements. Authority loading, enrollment and publication remain substantial
costs and need further profiling. No slow samples were removed.

The 10k Windows harness previously timed out creating loose synthetic objects before a measured
request. Packed seeding fixes that setup failure without reducing file count/content diversity.
All rows above use the corrected packed profile, not a mixture of old and new fixture layouts.

### workspace creation performance — Reproduce

Use the same Node version and idle host for both variants. Substitute a full immutable baseline
commit for `BASELINE`; the scripts compare bounded changed runtime modules, not arbitrary refs.

```sh
node scripts/workspace-creation-benchmark.mjs --samples=3 --files=1000 --control-ref=BASELINE --out=workspace.json
node scripts/workspace-creation-benchmark.mjs --samples=2 --files=10000 --control-ref=BASELINE --out=workspace-10k.json
node scripts/story-creation-benchmark.mjs --samples=3 --files=1000 --mode=isolated --configuration=approved --fresh=true --control-ref=BASELINE --out=story-cold.json
node scripts/story-creation-benchmark.mjs --samples=3 --files=1000 --mode=isolated --configuration=approved --fresh=true --prewarm=all --control-ref=BASELINE --out=story-prewarmed.json
node scripts/story-readiness-benchmark.mjs --files 1000 --output readiness.json
node scripts/intake-creation-benchmark.mjs --samples=2 --files=1000 --control-ref=BASELINE --out=intake.json
```

Workspace samples always create a fresh target and identical independent remote, including the
first state initialization. They never compare cold creation with warm no-op repair. Story samples
verify that the exact created branch tip was published, not merely that the CLI exited zero.
Variants alternate order. Both receive the same prewarm operation in `--prewarm=all`; preparation
time is reported separately and included in total-with-preparation, not presented as saved work.

The installed fixture includes `runtime/`, required by managed runtime resolution. Baseline bundles
are built in a separate installation with their own baseline `src/` and executable. This also
isolates dynamic package-root imports, which choosing a different bundle directory alone cannot
do. The fixture builder requires a local checkout of the baseline commit and at most 32 changed
runtime modules. Synthetic fixtures and private caches are removed after qualification.

### workspace creation performance — Interpret correctly

- Cold means a fresh Node process and empty private compile cache. OS disk caches are not flushed.
- Prewarmed request time excludes the separately reported runtime preparation cost.
- `nodeLaunchedGit` counts Git invocations made by the measured Node request, including direct async
  spawn sites omitted by some legacy product counters. It excludes detached workers and Git's own
  internal child processes. It records verb counts and inclusive elapsed time, not arguments.
- Existing `git.spawns` counters and Git Trace2 counts remain separately labelled; they are not
  interchangeable. Frozen enterprise transports can intentionally omit Trace2 environment values.
- Local bare remotes isolate process, filesystem and validation cost. They do not measure office
  proxy/DNS/credential latency, endpoint-security scanning attribution, or native Copilot turns.
- The workspace safety suite exercises destructive-action refusal, quarantine, recovery, and many
  independent clones. Its total duration is not one workspace or Story creation time. Run each
  file once; a negative `--test-name-pattern` is not a safe way to partition nested test groups.

### workspace creation performance — Safety and regression coverage

The full native workspace and clone-resume suites retain dirty/unpushed work, index flags, recovery
records, colliding targets and actual Windows directory locks. Fingerprint tests independently
reconstruct the old two-read manifest and require the same hash for ordinary, flagged, sparse and
conflicted indexes. AST tests cover deferred budgets, launch failures, revision changes and real
background completion. Intake receipt, ledger and activation tests preserve fresh authority/CAS,
symbolic-ref refusal and remote-state precedence. Checks, VS Code typechecking and builds accompany
native Mac and Windows measurements; platform-only cases are reported explicitly, not called passes.

The intake benchmark additionally exercises the editor-equivalent selected-base branch-folder
path, issues a genuine receipt and passes its exact returned repository path and receipt to
isolated Story start. It reports preview, start, combined latency and prewarm separately, using
private workspace registries, runtime/configuration caches and local remotes.

Large fixtures are seeded with a bounded `git fast-import` pack, retaining distinct file contents,
then an index-only `read-tree`. Setup refuses repositories with existing refs. This avoids tens of
thousands of loose-object writes and Windows antivirus/fsync delays before measurement; it does
not bypass or time-exclude any part of the measured clone, readiness, validation or publication.
Baseline and candidate use the same packed fixture profile. All comparisons must be rerun after
changing this profile; loose-object and packed-object results are not pooled.

On Windows, freshly created configuration pools receive protected current-user-only ACLs.
Git's successful filtered-fetch/seal can replace `config` via `config.lock`; that replacement must
prove bounded inert bytes and a unique regular inode before protection is restored. Existing
unqualified pools and failed transfers are never implicitly repaired, and final ACL validation
remains strict. Closed decline categories distinguish ACL, path, access and other storage failures
without retaining filenames, URLs or exception messages in metrics.

## Shared worktree and cold phase performance

### worktree context performance — Scope

This change removes repeated advisory worktree observations and unnecessary installed-bundle
loading from bound `phase enter`, composed phase entry, and agent `nextsteps` requests. It does
not skip lifecycle authorization, accept stale mutable state, or turn a drafting hint into
publication readiness.

The measured runtime is `00f1f8140fb63bbbf06d9a9dbc4d6f2109d752ef`, compared with main at
`447fe90433667deaf4ada23d78c72030aaa6467a`. Subsequent test-only portability corrections
`326a8da25e24c4bfd3bb4486baa82e72004175a9` and
`784c8239896e75c070584cd0822fcc1658bcb343` change no runtime or benchmark code.

### worktree context performance — Changes

- A read-only recovery operation shares one lossless porcelain-v2 observation. Ordinary paths
  can supply status, changed paths and a clean-index proof without more status/diff/history
  queries. Renames, submodules, conflicts, quoted/byte paths and ambient index selectors retain
  the original exact Git routes. Fresh Git boundaries bypass this observation.
- `nextsteps` inspects only the prospective primary draft and, when needed, runs one literal,
  path-scoped status query. Supporting documents remain part of the full publication/review
  checks; an incomplete supporting document still refuses publication.
- An explicitly bound composer acquires the Story lease before loading accepted composition
  context. Entry plus composition now loads full Story context twice rather than three times:
  once for entry and once freshly inside the lease. No mutable pre-lease context is trusted.
- Phase composition has a dedicated provider-free module. Actual installed chunk ownership
  keeps bound entry, composition and nextsteps out of compatibility/model-dispatch bundles.
  Optional release installers and unrelated World Model commands load only when needed.
- `--timings` reports bootstrap and V8 compile-cache flush separately on stderr. Ordinary
  stdout and the non-timed exit path are unchanged. Timing spans can be inclusive; do not add
  all spans together or attribute every unreported millisecond to Git.

Existing deployment-file, CLI closure, hook and VS Code bundle ceilings were not raised. The
existing safe runtime-prewarm policy was not broadened to model-dispatch chunks. Mutable
worktree observations last for one read operation, not the advisory 30-minute cache interval.

### worktree context performance — Measurement protocol

`scripts/phase-next-paired-benchmark.mjs` runs four alternating A/B and B/A pairs, reporting the
upper observed median and all raw samples. Both frozen revisions build with their **own**
builder and chunk ownership. Earlier pilot runs that applied the candidate builder to both
revisions were discarded, as were runs whose source identity changed during measurement.

All requests use installed bundles and a verified developer/Story/phase binding. Composed
requests must deliver admitted context; a refusal is not counted as a speedup. Legacy fixtures
have 20 application files. Pinned and amended fixtures have 1,000 files, 50 additional history
commits and eight supporting artifacts.

- Cold: fresh Node process, empty private V8 cache and a fresh local clone without provenance
  receipts. This is process/cache cold, **not** an OS cold boot; filesystem page cache is not flushed.
- Warm: an immediate new Node process against the same code/provenance caches, not an IPC worker.
- Prewarmed first: an independent fresh clone and V8 cache, prepared with `--warm-runtime`,
  without a prior request/provenance receipt. Preparation is measured separately, not free work.
- Persistent low-level Git fact storage is off; accepted-provenance receipts remain enabled.
  Measured requests make no network or model calls. Fixture creation, building and local cloning
  are outside request timing. File counters cover instrumented configuration/catalog sources,
  not every filesystem operation.

These are synthetic command measurements, not complete Story or native Copilot/LLM timings.
Hosted Windows results do not predict corporate antivirus, network-drive or OneDrive overhead.
Four pairs provide directional evidence, not universal latency guarantees.

### worktree context performance — This Mac

Native arm64 macOS, Node 22.14.0. Times are before → after, milliseconds.

| Profile | Request | Cold | Warm new process | Prewarmed first |
| --- | --- | ---: | ---: | ---: |
| Legacy | nextsteps | 329 → 261 | 190 → 166 | 239 → 168 |
| Legacy | phase entry | 432 → 326 | 291 → 232 | 342 → 234 |
| Legacy | composed entry | 683 → 552 | 391 → 287 | 593 → 463 |
| Pinned | nextsteps | 427 → 326 | 204 → 164 | 342 → 236 |
| Pinned | phase entry | 569 → 428 | 364 → 277 | 484 → 335 |
| Pinned | composed entry | 855 → 680 | 509 → 342 | 761 → 590 |
| Amended | nextsteps | 522 → 448 | 200 → 163 | 431 → 356 |
| Amended | phase entry | 714 → 582 | 502 → 416 | 627 → 519 |
| Amended | composed entry | 1,070 → 905 | 680 → 507 | 948 → 776 |

Cold reductions range from 14.1% to 24.7%; warm new-process reductions range from 12.7% to
32.8%. Candidate runtime preparation costs 174–183 ms across these cases. It should happen
ahead of a request: charging preparation to the foreground does not make it free.

Pinned composed entry illustrates the separate costs: cold process time falls from 855 to
680 ms; full Story context loads fall from three to two. The candidate explicitly measures
29 ms of compile-cache flush on this first composed request and zero on the immediate repeat.
This is one measured component, not an explanation for all remaining startup time.

### worktree context performance — Native hosted qualification

Both benchmark jobs in native run `39493732283` completed successfully with clean frozen
sources and admitted context in every row. The runtime is identical to the development Mac
comparison. Times below are before → after, milliseconds.

#### worktree context performance — Hosted macOS

Native arm64, Node 22.23.2.

| Profile | Request | Cold | Warm new process | Prewarmed first |
| --- | --- | ---: | ---: | ---: |
| Legacy | nextsteps | 713 → 496 | 424 → 330 | 499 → 361 |
| Legacy | phase entry | 804 → 642 | 586 → 494 | 668 → 474 |
| Legacy | composed entry | 1,419 → 1,102 | 827 → 608 | 1,214 → 947 |
| Pinned | nextsteps | 828 → 661 | 413 → 356 | 793 → 461 |
| Pinned | phase entry | 1,061 → 803 | 690 → 551 | 965 → 665 |
| Pinned | composed entry | 1,656 → 1,329 | 945 → 645 | 1,351 → 1,185 |
| Amended | nextsteps | 1,034 → 770 | 380 → 290 | 856 → 611 |
| Amended | phase entry | 1,277 → 1,008 | 892 → 748 | 1,057 → 856 |
| Amended | composed entry | 1,829 → 1,463 | 1,169 → 841 | 1,601 → 1,295 |

Cold reductions range from 19.8% to 30.4%; warm new-process reductions range from 13.8% to
31.8%. Candidate runtime preparation costs 298–378 ms.

#### worktree context performance — Windows

Native x64, Node 22.23.3; checkout conversion is enabled.

| Profile | Request | Cold | Warm new process | Prewarmed first |
| --- | --- | ---: | ---: | ---: |
| Legacy | nextsteps | 1,225 → 987 | 779 → 710 | 907 → 697 |
| Legacy | phase entry | 1,979 → 1,455 | 1,537 → 1,175 | 1,681 → 1,181 |
| Legacy | composed entry | 4,124 → 3,525 | 2,189 → 1,464 | 3,788 → 3,093 |
| Pinned | nextsteps | 1,939 → 1,759 | 968 → 720 | 1,654 → 1,248 |
| Pinned | phase entry | 2,993 → 2,170 | 1,975 → 1,485 | 2,720 → 1,935 |
| Pinned | composed entry | 6,621 → 5,712 | 2,614 → 1,867 | 6,552 → 5,389 |
| Amended | nextsteps | 2,812 → 2,374 | 998 → 730 | 2,483 → 2,067 |
| Amended | phase entry | 4,264 → 3,446 | 3,177 → 2,615 | 3,991 → 3,179 |
| Amended | composed entry | 8,261 → 7,603 | 4,237 → 3,054 | 7,588 → 5,121 |

Cold reductions range from 8.0% to 27.5%; warm new-process reductions range from 8.7% to
33.1%. Candidate runtime preparation costs 541–702 ms. Not every path improves equally:
pinned nextsteps saves 9.3% cold, and amended composition saves 8.0% cold despite removing
Git calls. Their remaining costs are visible rather than assumed away.

#### worktree context performance — Remaining first-request cost

The candidate's timed Windows composed entries report the following separate upper medians.
They are components of the same request; medians and nested spans are not additive.

| Profile | Cold wall time | Terminal command timing | Explicit V8 cache flush | Warm new-process wall time |
| --- | ---: | ---: | ---: | ---: |
| Legacy | 3,525 ms | 2,318 ms | 1,121 ms | 1,464 ms |
| Pinned | 5,712 ms | 3,233 ms | 2,443 ms | 1,867 ms |
| Amended | 7,603 ms | 4,735 ms | 2,783 ms | 3,054 ms |

This identifies cache persistence as a substantial measured cold component, not just module
loading or Git. Definition-only prewarming does not eliminate it: pinned composed entry still
reports a 2,339 ms cache flush after preparation. Do not assume a compile-cache write is a DNS,
network, LLM or repository-history delay. Cache-flush placement/serialization and the remaining
accepted-provenance/recovery reads are candidates for further controlled optimization; this
change does not disable caching or defer mutation checks to obtain smaller numbers.

#### worktree context performance — Ordinary-request control

Native run `39497865584` successfully repeated the pinned cases without `--timings`, using two
alternating pairs and the same clean baseline. Candidate `5669ab87b350c53928004a7589cacf34ac52a4c0`
adds only the benchmark's ordinary-request switch and the test-only corrections to the measured
runtime. No production runtime changed. Uncollected Git counters are `null`, never invented zeros.

| Host | Pinned request | Cold | Warm new process | Prewarmed first |
| --- | --- | ---: | ---: | ---: |
| macOS | nextsteps | 1,027 → 662 | 455 → 342 | 869 → 618 |
| macOS | phase entry | 1,412 → 843 | 828 → 590 | 1,186 → 729 |
| macOS | composed entry | 1,831 → 1,419 | 979 → 758 | 1,418 → 1,040 |
| Windows | nextsteps | 1,072 → 851 | 531 → 422 | 893 → 734 |
| Windows | phase entry | 1,695 → 1,354 | 1,182 → 808 | 1,482 → 1,051 |
| Windows | composed entry | 2,861 → 2,414 | 1,653 → 1,015 | 2,816 → 2,163 |

Windows ordinary controls improve 15.6–20.7% cold and 20.6–38.6% warm; the macOS control also
improves in every row. This confirms the direction for ordinary invocations, not a precise
instrumentation-overhead estimate. The controls ran on different hosted machines from the main
four-pair experiment, so do not subtract their timings across jobs to infer that cost. Two pairs
are a cross-check, not a substitute for the primary sample set. All results exclude Copilot/LLM time.

Use `--request-timings=false` to reproduce this control with the same harness.

### worktree context performance — Accepted qualification record

The accepted native selections cover 350 distinct targeted test cases on **each** host, with
zero failed, cancelled, skipped or todo cases in the accepted runs:

| Selection | Cases per host | Native run | Revision |
| --- | ---: | --- | --- |
| Snapshot, context, worker, provenance, parser, product-requirement and bundle integrity | 148 | `39494698111` | `326a8da2` |
| Unchanged phase-entry, fingerprint and preparation/evidence recovery cases | 106 | `39493732283` | `00f1f814` |
| Final lifecycle/report-restoration cases, including the strengthened symlink test | 96 | `39496834255` | `784c8239` |

The first full phase selection passed all 202 cases on macOS. Its Windows result was not accepted
as a complete qualification: two filesystem cases used invalid Win32 filenames, and one case
unconditionally skipped Windows. The affected 96-case selection was rerun on both hosts after
the test-only corrections; the other 106 passing cases and runtime code were unchanged. The
strict no-skip reporter was retained. The final integrity run also passed all 2,916 product checks,
VS Code typechecking and the VS Code build on both hosts.

The ordinary-control flag changes one existing benchmark child argv, not its executable or
process count. Its reviewed Git/process audit fingerprint was updated without adding a bypass,
registering a new owner, or raising an execution budget. The runtime changes precede all of
these test/harness-only follow-ups. Native run `39499064390` revalidated the final audit metadata
at `c1d3f20b` on both hosts; all 2,916 product checks passed again.

Qualification uses a disposable CI-only branch, never a production hosted workflow. Primary
benchmark artifacts from `39493732283` and ordinary controls from `39497865584` retain the raw
JSON samples and logs. This is a targeted performance/safety qualification, not a full repository
test-suite or 1.0 release certification.

### worktree context performance — Safety and qualification boundaries

Regressions cover external edits, fresh-boundary bypass, an alternate index, lagging Story
indexes, renames and quoted paths, exact draft names under host pathspec settings, supporting
document checks, and composition after an advisory memo becomes invalid. A bundled ESM
module-roster test exercises bound entry, composed entry and nextsteps and rejects either
compatibility or model-dispatch loading.

The native Git whitespace test uses supported space-containing names on Windows, since Win32
cannot create tab/newline filenames. Raw-byte parser cases still test control bytes on every
host; POSIX also round-trips them through the filesystem. No platform skip was introduced.
Lifecycle report fixtures likewise use bracketed rather than double-quoted filenames on
Windows. The report-restoration symlink test no longer skips Windows: it requires a proof
marker that the runner really created the symlink, then verifies restoration and the external
sentinel bytes. A host lacking that capability fails qualification rather than silently skipping it.

The benchmark also records candidate parent-owned IPC nextsteps first/repeat/prepared requests.
Those are not a native Copilot shell transport and are not included in the command gains above.
No actual Story, human approval, installed CLI or editor configuration is changed by these fixtures.

To reproduce, install locked dependencies in both frozen checkouts, then run from the candidate:

```sh
node scripts/phase-next-paired-benchmark.mjs \
  --baseline-engine=/absolute/path/to/baseline \
  --samples=4 --prewarmed=true --output=/absolute/path/to/results.json
```

The report records both clean commit identities, platform, Node version, all samples, physical
Git call counts, response bytes and measured stages. Source changes during measurement refuse
the report. Compare the same successful binding and temperature on the same host.
