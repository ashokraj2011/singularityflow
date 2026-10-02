# TRP qualification ledger

Observed on 2026-10-02 local time (host inventory checked at 2026-10-01T23:54:13Z; final matrix started at 2026-10-02T00:40:29Z). These are actual checkout-fixture executions, not a signed release approval, installed VS Code/Copilot qualification, or human-team pilot.

## Current native cells

| Environment | Runtime | Observed result | Scope |
| --- | --- | --- | --- |
| macOS, Darwin 25.6.0, arm64 | Node 22.14.0 | 131 passed, 0 failed, 0 skipped; 55.04 s | Policy, authority/store, intake/selection, native runner and risk lifecycle fixtures |
| macOS, Darwin 25.6.0, arm64 | Node 24.19.0 | 131 passed, 0 failed, 0 skipped; 54.41 s | Same eight files, independently executed under this runtime |
| Linux | Not qualified | Blocked: no suitable local Node/Git image | Docker Desktop's Linux/aarch64 daemon is available; only BusyBox 1.37.0 is installed locally |
| Windows | Not qualified | Blocked: no native Windows host available | No Windows execution or file-lock/wrapper qualification claimed |

The native cells used Git 2.54.0 and the real local PTY provided by Expect 5.45. Node 22 came from the existing Homebrew installation; Node 24 came from the existing bundled desktop runtime. The selected runtime's directory was first in `PATH`, including for child processes. No runtime, image or dependency was installed. The host-availability inventory inspected local services only; it did not contact a remote host.

Selected files:

- `test/test-recovery-policy.test.mjs`
- `test/test-recovery-store.test.mjs`
- `test/trp-delivery-selection.test.mjs`
- `test/test-selection-policy.test.mjs`
- `test/story-test-selection.test.mjs`
- `test/test-recovery-intake.test.mjs`
- `test/quality-command-runner.test.mjs`
- `test/story-test-risk-lifecycle.test.mjs`

Both final cells ran `node --test --test-reporter=spec` with all eight files in one invocation. They exercised pure gate dispositions and refusal cases, immutable record handling, real configured-local terminal review, local Git durability checks, exact test-scope confirmation and supported selection execution. The PTY harness is an automated fixture with isolated test identities, not evidence of an actual human participant.

The six lifecycle fixtures use real temporary Git repositories, passing Node baseline execution and actual native `ENOENT` launch failures. They cover separately authorized publication, submission, normal independent approval, downstream preparation and direct committed-receipt replay. The observation remains unavailable throughout; no current test pass is invented. Adversarial coverage includes fabricated/mutated launch provenance, different actual child environment, approved-command substitution, nondelegated/nonterminal review, wrong repository, stale `PATH`, executable symlink-target installation, expiry, revocation, altered intervening review commits and copied-checkout origin refusal. A valid structured command ID beginning with punctuation is retained exactly. Copying a checkout on this Mac is not qualification on a second physical host.

## Source and interpretation limits

The final cells ran after the implementation freeze from the working tree based on `ff78edb13e1a5ab21649dc8dbf2511cd6c7389ec`, including the production-risk changes under review and the final exact-object Git-read hardening. They are not an attestation of a final clean commit. Re-run affected cells after any further implementation edits before associating results with a release. Earlier exploratory five-file runs passed 98 tests under each runtime, and an earlier eight-file run also passed before the Git-read hardening; those preliminary counts are superseded by the final matrix, not added to it.

Early risk-lifecycle development iterations allowed read-only signed-in account resolution during identity checks. The final fixtures explicitly isolate test identities and use temporary repositories with local bare remotes; those earlier iterations are not evidence of an isolated final qualification run. No real Story or remote branch was modified by these fixtures.

The macOS Node 25.5.0 development runtime is also available, but a Node 25 run does not replace the Node 22/24 cells. A Docker daemon's reported Linux kernel is availability evidence only: no Linux repository test ran during this inventory. A simulated `win32` option or a script named `test:platform:windows` executed on macOS does not constitute Windows qualification.

## Remaining release evidence

TRP-AC-035 remains incomplete until actual Windows tests cover executable wrappers, drive/UNC paths, case behavior, report locking and interrupted cleanup, with Linux and macOS evidence reported independently. Existing GAL, CMP/WEL and SKP qualification drivers test their own scopes; their names or green results do not certify TRP lifecycle behavior.

This matrix qualifies only the bounded native-launch-unavailable production path described above. Known-failure acceptance, new-test-failure waivers, reduced coverage and document exceptions still lack complete production integration and are not enabled by green pure-evaluator tests. Genuine Jest, Vitest and JUnit runtime qualification is not claimed: no generated reporter JSON is presented as execution by an installed runner. Release qualification still needs actual Windows/Linux cells, installed extension/Copilot checks and a real human-team pilot with independent normal phase approval.
