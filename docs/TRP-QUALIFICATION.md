# TRP qualification ledger

Observed on 2026-10-02. These are actual checkout-fixture executions, not a signed release approval, installed VS Code/Copilot qualification, or human-team pilot. The nine-file matrix below precedes the raw runner-path and directory-snapshot hardening; affected-suite reruns are recorded separately.

## Installed extension-host smoke and remaining visual qualification

At 2026-10-02T02:27:24Z, the packaged 0.9.0 extension passed a real installed-host smoke on native macOS arm64, VS Code 1.140.0 (`07f806f999227108933c2e30515b26eecc1fda74`), using Node 24.19.0 for the engine. The VSIX SHA-256 was `a1021a0f69fbd5a99acb7f2661cb733202b3fa70e667af3b3d854ecd8a9a5bc1`. This package was built from the earlier `ef555cb` source, so this cell does not qualify later intake/document/risk UI edits until a final package is rerun.

The smoke loaded `singularityflow.singularity-flow-vscode` from its installed extension directory, not an extension-development copy or mocked `vscode` API. A separate fixture driver used real VS Code commands and native QuickPick selection to open the actual intake webview, display engine-generated recovery JSON, inspect the non-waivable unreviewed-agreement blocker, open the exact agreement authorization preview, and stage its command in a native terminal without submitting it. Git HEAD and Story workflow bytes were identical before and after. No risk decision or human approval was made. Report: `/private/tmp/sftrp-ui-lEFS35/installed-host-report.json`; package evidence and process log are beside it.

Reproduce after packaging with `node scripts/trp-installed-ui.mjs --vsix=/absolute/package.vsix`. The harness generates only disposable repositories with local bare remotes, synthetic fixture identities, isolated machine registries, a new VS Code user-data directory, a new extensions directory, and an isolated `HOME`. Model execution is disabled. Workspace trust is disabled only for this disposable extension-test process; system/VM settings are not changed. The initial interactive launch revealed that this VS Code version uses shared storage outside `--user-data-dir`; that attempt was stopped and subsequent launches isolated `HOME` as well. Homebrew Git is selected explicitly because the system Git refuses execution pending an Xcode license; the qualification did not accept that license.

The native accessibility attempt reached the isolated editor and its trust screen, but subsequent exact-window bindings failed with `noWindowsAvailable` and repeated `timeoutReached` errors. A final isolated launch with the editor-supported `--force-renderer-accessibility` flag also timed out; only that fixture process was terminated afterward. A subsequent supported browser inventory returned no browser bindings, so no arbitrary debugging attachment was used as a workaround. Therefore native visual interaction, intake radio/checkbox keyboard interaction, accessibility/visual layout, and Copilot-host behavior remain **not qualified**. The host smoke does not replace those checks. Pure UI tests separately cover option independence, no default consent, exact-digest invalidation, bounded review terms, fixed terminal arguments, document-obligation binding, and non-waivable refusal, but are not counted as installed visual tests.

A later explicitly authorized ordinary resume of the exact Windows 11 VM succeeded. Two bounded `cmd.exe /c ver` guest probes, separated by more than 60 seconds of independent work, both returned exit 255 because no Parallels guest session could be opened. Windows qualification stopped there. The user then requested that the VM be left untouched; no further access, probes, power actions or cleanup are permitted for this task. Resume success is not proof of a Windows desktop or runtime; no Windows test result is claimed. No force power, reset, boot-order, disk, security or guest-tools installation action was performed.

A genuine native Node skipped-case lifecycle fixture also passed on Node 24.19.0 (one test, 24.98 s): one case passed and one remained skipped through separately reviewed publication, submission, normal independent approval, replay and downstream use. This development result is additional evidence for reduced coverage, not part of the historical nine-file matrix or a final cross-platform rerun.

Separate exploratory native adapter qualification on macOS used Node 25.5.0 with real Python 3.14.4 / isolated-venv pytest 9.0.2, and Maven 3.9.16 / Temurin 25 / Surefire 3.2.5 / JUnit 4.13.2 (compiler release 17). Six adapter tests passed with zero skips, including real failing report capture and baseline compatibility; subsequent hardening needs its final rerun. This is not Linux or Windows adapter qualification. Without the explicit `SF_TRP_PYTEST_*` / `SF_TRP_MAVEN_*` runtime bindings, the installed-runner tests intentionally skip and are not qualification evidence.

## Native pytest and Maven adapter rerun

An additional development regression run of `delivery-evidence`, `story-lineage`, `environment-quality-command`, and `classic-delivery-workflow` on Node 25.5.0 passed 22/23 tests. The Classic delivery lifecycle fixture failed at its initial `start`: it never obtains the readiness receipt now required by its initialized policy. Running its unchanged file against an archive of original `ef555cb4` reproduced the identical failure (3 passed, 1 failed in that file). This is a pre-existing fixture setup failure, not a passing qualification cell or a reason to weaken the production readiness guard. Neither that fixture nor its production gate was changed for this task.

The final eight-case adapter file was executed serially on macOS arm64 using the existing real Python 3.14.4 / isolated-venv pytest 9.0.2 and Maven 3.9.16 / Temurin 25 installations. Maven used its isolated offline cache, clean-plugin 3.2.0, compiler 3.11.0 (release 17), Surefire 3.2.5 and JUnit 4.13.2. No adapter runtime was installed on or inferred for Windows or Linux.

| Engine runtime | Result | Duration |
| --- | --- | --- |
| Native macOS Node 22.14.0 | 8 passed, 0 failed, 0 skipped | 19.18 s |
| Native macOS Node 24.19.0 | 8 passed, 0 failed, 0 skipped | 34.69 s |

Each invocation ran `node --test --test-reporter=spec test/test-recovery-adapters.test.mjs` with explicit `SF_TRP_PYTEST_EXECUTABLE`, `SF_TRP_PYTEST_ROOTS`, `SF_TRP_MAVEN_EXECUTABLE`, `SF_TRP_MAVEN_ROOTS`, `SF_TRP_MAVEN_CACHE` and `JAVA_HOME` bindings to those retained disposable/installed toolchains. Four cases are always-on contract and refusal checks; four execute actual native runners, covering exact failing inventory/report retention and baseline compatibility. The adapter SHA-256 was `ce35922ed34e989d3bee31968b58829c1c24bf95e347135b57ff573ad136ba7b`, its test file `f6299f8bc3049222142e2a66c8da8b519956c9cbbd55e54c6da422648155cab9`, and shared runtime `6ddab15ba764e4ecc82dcae1e1d7e51d295a0c8caee88aa54ec2ad364ef19032`; these bytes were verified again afterward. These cells do not qualify still-changing intake orchestration or the installed UI.

## Expanded cross-platform matrix and final isolated-intake correction

The 28-file expanded matrix started at 2026-10-02T02:57:24Z on the working tree based on `ef555cb4`. It exercised actual fixture Git/PTY lifecycles for unavailable, failed, known-baseline, skipped/reduced-coverage and supplemental-document decisions; reviewed command amendments; readiness repair; precise selection; and UI contracts. These are fixture executions, not human participation or installed visual interaction.

| Environment | Expanded matrix | Duration | Final affected rerun | Duration |
| --- | --- | --- | --- | --- |
| macOS arm64, Node 22.14.0 | 303 passed, 0 failed, 4 skipped | 331.59 s | 26 passed, 0 failed, 0 skipped | 55.47 s |
| macOS arm64, Node 24.19.0 | 303 passed, 0 failed, 4 skipped | 318.64 s | 26 passed, 0 failed, 0 skipped | 54.44 s |
| Linux aarch64/bookworm, Node 24.21.0 | 303 passed, 0 failed, 4 skipped | 275.72 s | 26 passed, 0 failed, 0 skipped | 37.17 s |

All four matrix skips are the explicitly configured native pytest/Maven cases. The separate eight-case macOS runs above qualify those real installed runners; Linux does not. Repeated cases across the full matrix and affected or adapter reruns are not added together as distinct tests.

During the broad runs, a final narrowly scoped correction allowed an authenticated failed readiness receipt to establish the independent non-test prerequisite passes it actually contained, while preserving failed tests and refusing missing or failed prerequisites. Therefore the broad cells alone are **not** claimed as a byte-identical final-source matrix. The final three-file rerun started at 2026-10-02T03:03:16Z after synchronizing the final CLI/intake bytes and six-case known-baseline fixture. It ran `story-test-known-baseline` (6), `test-recovery-intake` (18), and `story-test-isolated-baseline-preview` (2), including a genuinely strict dependency requirement, refusal before its proof, and successful target-native admission after independently satisfied prerequisites.

Final SHA-256 bindings, checked again after the affected runs:

| File | SHA-256 |
| --- | --- |
| `src/cli.mjs` | `d22a8fe1b61bf96f062ad0d3c167206f1c9728413316b6a5463df3d0761d8911` |
| `src/test-recovery-intake.mjs` | `30262b14c847648e685ea69413073d09f1e90355a8f4f8921be7bb8fb29c9aa4` |
| `src/test-recovery-runtime.mjs` | `6ddab15ba764e4ecc82dcae1e1d7e51d295a0c8caee88aa54ec2ad364ef19032` |
| `src/test-recovery-adapters.mjs` | `ce35922ed34e989d3bee31968b58829c1c24bf95e347135b57ff573ad136ba7b` |
| `test/story-test-known-baseline.test.mjs` | `1cf4e22399d2e4d2df684f10dad882ffa76bc582605c0d7bd6af7c127e6c75b5` |

Commands used `node --experimental-strip-types --test --test-reporter=spec --test-concurrency=2` for the broad cells and the same test settings without type stripping for the three affected files. Logs are retained under `/tmp/sftrp-final-matrix-Cw5nhw`. Selected broad files (all under `test/`):

```text
story-test-command-amendment-lifecycle.test.mjs
story-test-command-amendment.test.mjs
test-command-amendment-contracts.test.mjs
story-test-known-baseline.test.mjs
story-test-risk-command.test.mjs
story-test-risk-lifecycle.test.mjs
story-test-selection.test.mjs
test-recovery-adapters.test.mjs
test-recovery-admission.test.mjs
test-recovery-baseline-compatibility.test.mjs
test-recovery-intake.test.mjs
test-recovery-node.test.mjs
test-recovery-policy.test.mjs
test-recovery-repair-scope.test.mjs
test-recovery-repair.test.mjs
test-recovery-store.test.mjs
test-selection-policy.test.mjs
trp-delivery-selection.test.mjs
trp-document-runtime.test.mjs
trp-intake-cli.test.mjs
trp-repair-lifecycle.test.mjs
trp-selection-lifecycle.test.mjs
vscode-story-test-recovery.test.mjs
vscode-story-test-risk.test.mjs
vscode-trp-intake.test.mjs
quality-command-runner.test.mjs
story-worktree-prepared.test.mjs
story-test-isolated-baseline-preview.test.mjs
```

The Linux runs used official `node:24-bookworm`, image digest `sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4`, Git 2.39.5 and Expect 5.45.4. Source was copied without AppleDouble metadata. Locked dependencies used `npm ci --ignore-scripts`; tests ran as nonroot `node`, after disconnecting networking, with no mounts, host home, credentials or Docker socket. Limits were 2 CPUs, 3 GiB and 256 processes. This is runtime qualification, not containment certification. After verifying its qualification label and empty mount/network lists again, the exact disposable container `2ca46caed8c90133be37502d300e104fef927a4c388f701c3d508fc10265fc4d` was stopped and removed. The downloaded image cache and host-side logs were retained. Native macOS used Git 2.54.0 / Expect 5.45 and selected Node first in `PATH`. The separate full legacy editor suite passed 324/324 and extension typechecking passed; those are not added to the matrix counts.

## Historical nine-file matrix before final path hardening

| Environment | Runtime | Observed result | Scope |
| --- | --- | --- | --- |
| macOS, Darwin 25.6.0, arm64 | Node 22.14.0 | 150/150; 192.14 s, then final intake/schema 18/18; 0.45 s | Nine files plus a later schema-parity test; 151 distinct cases, zero failures/skips |
| macOS, Darwin 25.6.0, arm64 | Node 24.19.0 | 150/150; 188.48 s, then final intake/schema 18/18; 0.45 s | Independently executed under this runtime; 151 distinct cases, zero failures/skips |
| Linux, kernel 6.10.14-linuxkit, aarch64, Debian bookworm container | Node 22.23.3 | 151/151; 135.50 s | All nine final files including schema parity; zero failures/skips, real Linux processes, local Git and PTY |
| Windows 11 ARM VM, Parallels 27.0.2 | Not qualified | Earlier UEFI screen; latest status running but guest execution unavailable | No Windows execution or file-lock/wrapper qualification claimed; no reset, boot or security changes performed |

## Path-hardening rerun before directory-snapshot correction

These runs started at 2026-10-02T01:21:18Z and used `test/test-recovery-node.test.mjs`, `test/trp-delivery-selection.test.mjs` and `test/story-test-risk-lifecycle.test.mjs` with `node --test --test-reporter=spec`. They precede the subsequent directory-snapshot correction.

| Environment | Result | Duration |
| --- | --- | --- |
| macOS Node 22.14.0 | 35 passed, 0 failed, 0 skipped | 207.83 s |
| macOS Node 24.19.0 | 35 passed, 0 failed, 0 skipped | 199.78 s |
| Linux Node 22.23.3 | 35 passed, 0 failed, 0 skipped | 128.86 s |

These affected-suite results cover the final helper bytes with SHA-256 `1faaa882c0b43650a829e9fc952ae2da0b4ad7466e1d4001a891ee80f5b2c4b3`. The first hardening attempt passed 34/35 on each platform: it also rejected the planner's legitimate single `./` prefix. The final correction permits that prefix while rejecting absolute, parent-normalized, drive, UNC and backslash arguments; both positive selector and adversarial path tests passed. Those failed intermediate runs are not represented as passes. This is an affected-suite rerun, not a claim that the entire earlier 151-case matrix ran against identical final source bytes.

## Final affected-suite rerun after directory-snapshot correction

The same three affected suites ran again starting at 2026-10-02T01:31:45Z after adding all ordinary directory paths/types/modes to retained-execution dependency snapshots, including empty ignored directories. These supersede the preceding affected-suite cells for the final runtime implementation.

| Environment | Result | Duration |
| --- | --- | --- |
| macOS Node 22.14.0 | 35 passed, 0 failed, 0 skipped | 182.82 s |
| macOS Node 24.19.0 | 35 passed, 0 failed, 0 skipped | 180.16 s |
| Linux Node 22.23.3 | 35 passed, 0 failed, 0 skipped | 135.45 s |

The final runtime SHA-256 is `5a0fc8e0a8941c7264bd002f9bd28765d003748328b53acb01274f3249bc9e83`; the helper hash above is unchanged. The lifecycle fixture proves creating an ignored empty directory invalidates accepted failed evidence and removing that exact directory restores the prior binding. It also starts with no approved report-parent directory: read-only planning leaves it absent, while actual execution securely creates the exact report parent before taking its dependency snapshot. No directory is silently exempted from freshness merely because it is a report parent. The final source hashes were checked again after completion. All disposable qualification containers were then stopped and removed by verified exact IDs; the official image cache was retained.

The macOS cells used Git 2.54.0 and the real local PTY provided by Expect 5.45. Node 22 came from the existing Homebrew installation; Node 24 came from the existing bundled desktop runtime. The selected runtime's directory was first in `PATH`, including for child processes.

The Linux cell used official `node:22-bookworm` image digest `sha256:363e1587494626837fa7f9a23bdb453d13b0ff3c67c705c2805cfc69c2d2fad7`, Git 2.39.5 and Debian Expect 5.45.4. Locked project dependencies were installed with `npm ci --ignore-scripts` inside the disposable container. Tests ran as its nonroot `node` user with no host mounts, credentials, Docker socket or host home directory, and after disconnecting the container's network. Limits were 2 CPUs, 3 GiB and 256 processes. Docker Desktop's daemon uses unconfined seccomp: these are Linux runtime results, not a sandbox or containment certification. The official image and Debian/npm dependencies were downloaded; test remotes were isolated local bare repositories.

Selected files:

- `test/test-recovery-policy.test.mjs`
- `test/test-recovery-store.test.mjs`
- `test/trp-delivery-selection.test.mjs`
- `test/test-selection-policy.test.mjs`
- `test/story-test-selection.test.mjs`
- `test/test-recovery-intake.test.mjs`
- `test/quality-command-runner.test.mjs`
- `test/test-recovery-node.test.mjs`
- `test/story-test-risk-lifecycle.test.mjs`

Each cell ran `node --test --test-reporter=spec` with all nine files in one invocation. The macOS processes had already loaded the intake file when a final shipped-schema parity case was added, so the complete 18-case intake file was rerun on both runtimes. Linux's final full run included that case and also passed a separate 18-case intake rerun. Repeated tests are not added to distinct-case counts. These runs exercised pure gate dispositions and refusal cases, immutable record handling, real configured-local terminal review, local Git durability checks, exact test-scope confirmation and supported selection execution. The PTY harness is an automated fixture with isolated test identities, not evidence of an actual human participant.

The 13 lifecycle fixtures use real temporary Git repositories, passing Node baseline execution, actual native `ENOENT` launches and actual failed Node JUnit executions. They cover separately authorized publication, submission, normal independent approval, downstream preparation and direct committed-receipt replay. Observations remain unavailable or failed throughout; no current test pass is invented. Adversarial coverage includes fabricated/mutated launch provenance, different actual child environment, approved-command substitution, nondelegated/nonterminal review, wrong repository, stale `PATH`, executable symlink-target installation, expiry, revocation, altered intervening review commits and copied-checkout origin refusal. A valid structured command ID beginning with punctuation is retained exactly. Copying a checkout within one host is not qualification on a second physical host.

## Source and interpretation limits

The nine-file macOS matrix started at 2026-10-02T01:10:30Z; Linux's corrected-copy run started at approximately 01:12:01Z. These ran the working tree based on `334033b9f2301f6cff73764149bd6b3645bca849`, including the new failed-test adapter changes, not a final clean commit. A later review hardened raw runner file arguments before path joining so absolute/parent/drive/UNC forms cannot be normalized into an approved relative inventory. The earlier matrix does not claim to include that production change. Re-run affected cells after further implementation edits before associating results with a release.

Earlier eight-file baseline runs passed 131 tests on each platform: macOS Node 22 in 55.04 s, macOS Node 24 in 54.41 s and Linux Node 22 in 37.07 s. Those counts are historical, not added to the final matrix. An intermediate Linux resync accidentally emitted macOS AppleDouble sidecar files; all 13 lifecycle setups then refused malformed agent templates. Only validated generated AppleDouble metadata was removed from the disposable container, and the source was recopied with `COPYFILE_DISABLE=1` before the successful final run. This test-copy failure was not hidden as a passing qualification cell.

Early risk-lifecycle development iterations allowed read-only signed-in account resolution during identity checks. The final fixtures explicitly isolate test identities and use temporary repositories with local bare remotes; those earlier iterations are not evidence of an isolated final qualification run. No real Story or remote branch was modified by these fixtures.

The macOS Node 25.5.0 development runtime is also available, but a Node 25 run does not replace the Node 22/24 cells. A simulated `win32` option or a script named `test:platform:windows` executed on macOS does not constitute Windows qualification. In this historical matrix, the Parallels VM's `running` state was not evidence that Windows had booted: a visible window showed firmware, and a later UI showed disk-space management rather than an ordinary Continue action. A bounded `cmd.exe /c ver` guest query failed with exit 255 because a guest session could not be opened. The VM was already running at that point, so Resume was inapplicable and no power action was taken during that matrix. The separately authorized later ordinary resume and the subsequent stop instruction are recorded above.

## Remaining release evidence

TRP-AC-035 remains incomplete until actual Windows tests cover executable wrappers, drive/UNC paths, case behavior, report locking and interrupted cleanup, with Linux and macOS evidence reported independently. Existing GAL, CMP/WEL and SKP qualification drivers test their own scopes; their names or green results do not certify TRP lifecycle behavior.

The matrix covers the bounded native-launch-unavailable path and the narrowly declared native Node failed-test adapter. The latter uses actual native JUnit output, two independently approved flat cases (one passed and one failed), and distinct live-reviewed permissions for publication, submission, normal approval, replay and downstream preparation. It also tests a pinned test-automation-only boundary, incomplete/extra/skipped/duplicate cases, full child-environment drift, ignored dependency changes and durable raw-report tampering, including restoration of exact original bytes before valid reuse.

The failed-test adapter is deliberately narrow: repository-local and Node-builtins-only dependency scope must be explicitly approved. It is not a hermetic runner. Local dependency snapshots include ignored files/data and ordinary directories (including empty ones) and fail closed above 16,384 entries, 4 MiB per file or 64 MiB total, or on symlinks/hardlinks. General npm installations and external/live-service dependencies are not qualified. The exact effective child environment is bound; framework transport controls are omitted from the actual child, not merely ignored by hashing. Old Node reporters without testcase file attributes qualify only a single independently declared explicit source file; multiple-file identity cannot be inferred from names. Flat top-level cases only are supported. No genuine Jest or Vitest qualification is claimed, and Node's native JUnit output does not qualify arbitrary JUnit-producing runners.

The historical matrix above does not qualify the later known-failure carry-forward, reduced-coverage, document-exception or additional runner implementations. Their implementation and targeted tests must be reported separately and included in a final native matrix before broader release claims. Actual Windows wrapper/path/locking/cleanup tests, installed visual/Copilot checks and a real human-team pilot with independent normal phase approval remain outstanding. Interrupted initial creation/amendment and pending-publication risk recovery still need scenario-specific failure-injection evidence; copied-checkout refusal alone does not prove a complete fresh local observation recovery route.
