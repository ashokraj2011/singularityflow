# TRP qualification ledger

Observed on 2026-10-02. These are actual checkout-fixture executions, not a signed release approval, installed VS Code/Copilot qualification, or human-team pilot. The nine-file matrix below precedes the raw runner-path and directory-snapshot hardening; affected-suite reruns are recorded separately.

## Nine-file matrix before final path hardening

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

The macOS Node 25.5.0 development runtime is also available, but a Node 25 run does not replace the Node 22/24 cells. A simulated `win32` option or a script named `test:platform:windows` executed on macOS does not constitute Windows qualification. The Parallels VM's `running` state is not evidence that Windows has booted. An earlier visible window showed firmware, not a Windows desktop; the latest UI showed disk-space management rather than an ordinary Continue action. A final bounded `cmd.exe /c ver` guest query failed immediately with exit 255 because a guest session could not be opened. The VM was already running, so Resume was inapplicable. No Continue, Resume, shutdown, reclaim, archive, boot-order or security action was performed.

## Remaining release evidence

TRP-AC-035 remains incomplete until actual Windows tests cover executable wrappers, drive/UNC paths, case behavior, report locking and interrupted cleanup, with Linux and macOS evidence reported independently. Existing GAL, CMP/WEL and SKP qualification drivers test their own scopes; their names or green results do not certify TRP lifecycle behavior.

The matrix covers the bounded native-launch-unavailable path and the narrowly declared native Node failed-test adapter. The latter uses actual native JUnit output, two independently approved flat cases (one passed and one failed), and distinct live-reviewed permissions for publication, submission, normal approval, replay and downstream preparation. It also tests a pinned test-automation-only boundary, incomplete/extra/skipped/duplicate cases, full child-environment drift, ignored dependency changes and durable raw-report tampering, including restoration of exact original bytes before valid reuse.

The failed-test adapter is deliberately narrow: repository-local and Node-builtins-only dependency scope must be explicitly approved. It is not a hermetic runner. Local dependency snapshots include ignored files/data and ordinary directories (including empty ones) and fail closed above 16,384 entries, 4 MiB per file or 64 MiB total, or on symlinks/hardlinks. General npm installations and external/live-service dependencies are not qualified. The exact effective child environment is bound; framework transport controls are omitted from the actual child, not merely ignored by hashing. Old Node reporters without testcase file attributes qualify only a single independently declared explicit source file; multiple-file identity cannot be inferred from names. Flat top-level cases only are supported. No genuine Jest or Vitest qualification is claimed, and Node's native JUnit output does not qualify arbitrary JUnit-producing runners.

Known-failure carry-forward, reduced coverage, document exceptions and general evidence reuse remain unsupported production categories. Actual Windows wrapper/path/locking/cleanup tests, installed extension/Copilot checks and a real human-team pilot with independent normal phase approval remain outstanding. Interrupted initial creation/amendment and pending-publication risk recovery still need scenario-specific failure-injection evidence; copied-checkout refusal alone does not prove a complete fresh local observation recovery route.
