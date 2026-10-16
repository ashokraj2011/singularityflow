# First-request isolated Story performance

This follow-up adds Git batching, shared approved-configuration compilation and optional
VS Code runtime prewarming. It builds on [isolated creation](ISOLATED-STORY-PERFORMANCE.md),
not a replacement readiness/approval engine. The paired control is main at
`ec2a79213f1729f6170265cbb4c737faf213e011`. Raw macOS results are retained in
[first-request-macos.json](../benchmarks/story-creation/first-request-macos.json).

## What changed

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

## macOS qualification

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
[preliminary run](../benchmarks/story-creation/first-request-macos-preliminary.json) was 2.1%
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

## Native Windows: reject the expensive cache default

The [intermediate cold results](../benchmarks/story-creation/first-request-windows-intermediate.json)
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

## Final native Windows qualification

The [final Windows results](../benchmarks/story-creation/first-request-windows.json) use the same
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

### Latest-main integration

The timing baseline remains `ec2a7921` and the Windows candidate is `aed2bb5a`; raw records bind
those revisions. Main subsequently advanced to `3568c1af`. Its five commits (skills-audit and
step-owned-artifact recovery fixes plus gateway budgets) were inspected and merged, not overwritten.
The combined build passes the newer upstream gateway budget without raising it again, and the
86 affected Mac phase-entry, recovery and polyglot tests pass. The merged source also passed a
separate native Windows run (CI `38933205030`): Git/configuration/recovery/prewarming tests,
the default-cache policy test, type checking, bundle limits and one fresh approved-configuration
isolated creation with exact local/remote tip verification. Its
[raw smoke record](../benchmarks/story-creation/first-request-windows-merged-smoke.json) has zero
application files and one sample: it verifies integration, not a performance distribution.
Do not relabel the earlier timing distributions as measurements of this later merged revision.

## Reproduce on either operating system

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

## Safeguards and limits

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
