# Automatic installation-receipt upgrade qualification

Qualified on 2026-10-21. Runtime/source implementation: `26d30b3642d2360e33b5d4ceaea086157cd31539`.
Fresh-main baseline: `c7ba93760bbc5f028d7339a07e83144136f7b0e8`.
Native qualification run: `39561410451`; its temporary workflow is not a production asset.

## Native results

| Host | Node | Passed | Failed | Platform skips |
| --- | --- | ---: | ---: | ---: |
| macOS | 22.23.3 | 253 | 0 | 3 |
| macOS | 26.12.0 | 253 | 0 | 3 |
| Windows | 22.23.3 | 255 | 0 | 1 |
| Windows | 26.12.0 | 255 | 0 | 1 |

Each job also passed all 2,942 product checks, VS Code typechecking and the VS Code build.
The three macOS skips are the existing Windows-native bootstrap argv, timeout/descendant-tree,
and exclusive-file-lock cases, which execute on Windows. Windows skips the existing POSIX fake
npm harness, which executes on macOS. No new receipt-upgrade case is skipped on either platform.
These are scoped regression results, not a zero-skip 1.0 release qualification.

The local Mac additionally passed the existing POSIX source-installer suite: the combined
13-file run reported 269 passes, zero failures and the same three Windows-only skips (272 tests).
Product checks, typechecking and build also passed locally. An initial Windows qualification
exposed test-fixture PATH initialization, not a production Git failure; the corrected fixture
prepends its fake managers inside Git Bash before executing the installer. The final run above
includes that correction and both subsequent safety fences.

## Safety and compatibility coverage

- Full normal source install detects v1 before cleanup/dependency work and upgrades automatically,
  with and without an explicit test opt-out; the non-opted-out installer still runs its full suite.
- Exact old receipt bytes, including formatting, are retained once at their digest-addressed path.
  The v2 receipt and audit bind that archive; old artifact claims never become rollback authority.
- Replacement package/build identity, CLI, VSIX and Copilot verification precede the v2 commit.
  Current-receipt and archive integrity are rechecked at that commit boundary.
- Failed builds/activation retain old metadata and the exact candidate for roll-forward recovery.
  Exact-plan retries preserve lineage; rejected commits do not leave a false successful audit.
- Workspace registrations, Story/repository files and completed recovery journals stay unchanged.
  Live leases and pending activation, distribution-install or uninstall recovery remain authoritative.
- Receipt drift during build/activation, archive tampering/conflicts, linked directories, malformed
  or future records refuse safely. Partial-surface install requests are never silently expanded.
- A missing old CLI can be repaired without trusting its receipt as proof of installed bytes.
  Existing v2 installation, rollback, storage-cleanup and product-alignment regressions pass.
- About/alignment diagnostics point to the full automatic source-install route rather than a generic
  archival-reader dead end. Reading those diagnostics never mutates the old receipt.

Native test runs cover real local filesystem, hashing, archive and Git Bash behavior in disposable
homes. Product manager commands are injected/non-mutating; they do not replace the operator's
actual CLI, editor or Copilot installation. This is not an attestation about office network policy,
antivirus behavior, or a real power-loss interruption. Managed-runtime and promoted-distribution
regressions are covered, but their separate receipt/rollback policies are not weakened by this fix.

The focused upgrade/service cases are in `test/installation-receipt-upgrade.test.mjs` and
`test/reinstall.test.mjs`, and are included in `npm run test:reinstall`. The native regression also
runs staged-artifact recovery, installation storage, distribution bootstrap/bundle/install,
uninstall, direct-skill, plugin, product-alignment and About suites. Node 22's About UI tests use
`--experimental-strip-types`. No hosted workflow is merged into the product checkout.
