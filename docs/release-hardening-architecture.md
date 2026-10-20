# Release-hardening architecture review

This records code-local implementation review, not independent release approval or platform
qualification. The product version and release latency gates are unchanged.

## Windows atomic replacement

`writeAtomic` retries only Windows sharing failures, using the same complete temporary file.
It never deletes the destination or replaces atomic rename with a copy. Five waits total 620 ms;
permanent errors keep their native identity. Its existing `finally` removes the owned temporary.
Exclusive/no-clobber authority writers do not use this replacement operation.

The Windows-only loop is dynamically loaded from `atomic-replace.mjs`, keeping it outside the
root CLI's eager closure. Pure retry tests and native concurrent-writer tests cover the boundary.
The root's 39-file/780,000-byte ceilings and every bundled byte ceiling remain unchanged.
The help and support bundles each allow exactly one additional module for this mutation-only
helper (130 and 107). No new bundle entry or unrelated domain is admitted. Gateway's module
ceiling remains 733: canonical clarification paths now share the existing Story-path owner,
with the old import path retained as a compatibility export.

## Artifact checkout representation

Publication reconciliation recognizes exact authored text or a uniform LF/CRLF checkout
representation. It retains the distinct raw worktree and immutable-blob hashes. A mixed editor draft
is eligible only when CRLF-to-LF conversion reproduces the exact immutable authored text and Git's
current text/eol/autocrlf policy explicitly performs that conversion. Custom filters, alternate
encodings, binary/NUL data and absent conversion policy cannot establish that exception. No filter
is executed. Arbitrary carriage returns, BOMs, whitespace changes, missing newlines and content
changes remain refused. Managed metadata accepts either uniform envelope format and is replaced,
not duplicated.
This follows the existing distinction between immutable Git bytes and checkout text; it does not
relabel different raw hashes as equal or waive review/publication requirements.

The terminal approval-integrity check applies the same narrow rule to source/test snapshots after
a stable, no-follow byte read. The alternate representation must reproduce the exact approved raw
size and SHA-256. Invalid UTF-8, binary NUL and BOM-bearing variants are ineligible. Original
snapshot records remain unchanged. A later approved repair owner is checked by the same rule;
an unapproved content edit is not a successor and remains stale.

The managed artifact writer uses LF only when the current Git text policy proves that exact
conversion and no filter/alternate encoding applies. Registration and submission therefore bind
bytes that the commit can actually retain, including when an editor started from a mixed draft.
Generation sidecars are captured after final metadata and the artifact scan, never from the draft
that preceded the lifecycle rewrite.

Historical review replay may prove an exact uniform LF/CRLF counterpart only after verifying its
regular Git mode at the evidence commit. The immutable packet is not changed; the derived result
discloses both raw identities. Mixed endings, content edits, wrong sizes and link modes remain
refused. Exceptional mode reads are batched and bounded. This narrow reader is loaded on demand
from a package-owned file URL, keeping the existing eager bundle byte/module ceilings unchanged.
Removal claims use a successful listing at that exact commit; an unreadable blob is never treated
as proof that the file was deleted.

## Explicit MCP setup

Windows host attestation and warm-up may secure a legacy MCP container after explicit confirmation
or network consent. Only the container's ACL changes; retained data is not traversed. Topology and
the resulting ACL are reverified. Doctor/readiness never repair permissions implicitly.

## Prompt-file staging

The source directory entry is checked before opening and rebound after reading. Descriptor identity
uses BigInt file IDs, including on Windows where `O_NOFOLLOW` may be unavailable. Symbolic links,
replacement races and writes during staging are refused before a prompt snapshot is handed off.

## Qualification and recovery ownership

A normal source install claims/checks the activation lease before `git pull`, so an interrupted
activation cannot lose its exact installer/validator merely because someone retries with
`--skip-tests`. A pending journal refusal reports its exact path, checkout and recorded recovery
command for review; it never deletes, replaces or resets that operation. Already-drifted legacy
installers still require their exact retained source to be restored through reviewed recovery;
this change does not invent authority to run different recovery code.
The Windows Git Bash wrapper delegates its update choice to that same owner; it performs no
separate repository/status/pull operation before admission.

Story-source readers share a stable, no-follow byte read. Story creation pins JSON-with-LF bytes;
only an unchanged uniform CRLF checkout may reproduce that immutable SHA-256. Raw checkout and
immutable identities remain separate. Prompt composition receives the original pinned identity,
not a rewritten workflow pin. Documents, Epic-source inspection and the legacy configuration
integrity gate use the same reader. Mixed endings, BOM, whitespace/content edits and missing
sources do not synthesize or change Story intent.

The POC gate gives every stage a throwaway home and all machine-state pointers, not merely an
alternate workspace registry. The strict skipped-test policy remains enabled. Caller Node loaders
and recursive test markers are not inherited by the qualification children.

Diagnostic continuation is permitted only after the process owner reports quiescence. An unknown
cleanup outcome or thrown execution-owner failure stops the run and retains the owned scratch
directory, reporting its exact path without deleting potentially active recovery state. A late
native child acknowledgement cannot turn the bounded refusal into an unhandled exception.

Opportunistic workspace cleanup now keeps the worker's IPC channel alive through asynchronous
imports and journal publication. The parent unreferences its own handles immediately; the worker
disconnects after completion or retained failure. Foreground Story operations do not wait for it.

The isolated VS Code installation smoke uses the centralized native process resolver for Windows
command shims and preserves launch, timeout and signal details. Installation and a stub-host journey
are separate checks; neither is represented as real renderer activation or independent human review.
An installation timeout or signal retains the owned profile and reports its path rather than
deleting under an unconfirmed child. Ordinary completed success/failure still cleans that profile.

## Qualification record — 2026-10-20

**Not qualified for 1.0.** The product remains 0.9.0. This record grants no release approval,
waiver, publication or merge permission. Skipped, cancelled and TODO tests still fail release
verification; no platform-applicability exception was introduced.

The frozen code point is `3a0f0cd9cb50f5a8bd6f0f5d45b2b6de74f15fc8`.

| Evidence | Scope and result |
| --- | --- |
| Local Mac, Node 22 | 122 isolated publication, immutable-review, execution-evidence, sidecar and complete specification-to-release Story tests passed; zero skips. |
| Native Mac and Windows, Node 20 and 22 | 39 focused reader/runtime/bundle tests passed in each cell, zero skips; run `39390249048`. This is not the full repository suite. |
| Native Mac and Windows, Node 22, frozen code | Packaged intake through submission, independent fixture approval, Copilot handoff and restart passed on both hosts. The separate specification-through-release Story and exact VSIX-contained engine check also passed on both hosts; run `39390249048`. Intake took about 79 seconds on Mac and 292 seconds on Windows; the full specification Story took about 122 and 490 seconds respectively. These are single-run durations, not a matched performance comparison. |
| Native Windows packaged intake | Seven tests passed, zero skips, including intake, submission, independent fixture approval, Copilot handoff and restart; run `39389479908` at parent code point `b1a78cc3`. The later removal-proof change is covered by the frozen native reader tests. |
| Mac packaged gate | Eleven of twelve stages passed at `1077c5cc`, including 237 regression tests, packaged intake, contained-engine verification and isolated CLI installation. The latency-budget stage failed. |
| Locked dependencies | The audit at this qualification run reported zero vulnerabilities. |

These are automated fixture observations, not real Copilot authoring, a human pilot or real VS Code
renderer activation. The packaged intake check does not claim completion of every POC phase.
The separate specification-to-release CLI fixture does exercise the full phase sequence and rework.

Whole-suite qualification is still incomplete. The original complete Mac baseline at `97499663`
executed 11,531 tests: 11,491 passed, 26 failed and 14 skipped. Later fixes and focused reruns do not
retroactively change that receipt. The newer whole-suite rerun has no accepted passing aggregate.
That rerun is bound to `1077c5cc`, not the frozen code point above. Its completed shards already
include platform-specific skips and a fixture cleanup failure (`ENOTEMPTY`), so it cannot qualify
the release even if all remaining shards pass. The generated-file check also failed on that older
snapshot; its stale Windows-wrapper Git audit fingerprint was corrected in `654d0d06`, but that
focused correction does not replace a new whole-suite receipt.
The native Windows baseline also exposed portability failures and an incomplete timed-out shard;
there is no passing complete Windows aggregate.

Remaining release blockers include platform/filesystem-specific skips, the unqualified whole-suite
results, and absolute latency budgets. The local latency run was contended and had no matching
accepted baseline: it is a failed gate, not evidence of a measured regression or speedup.
Native interactive-host and genuine human acceptance are not established by these fixtures.

Reproduce strict whole-suite qualification on each supported native host, from a clean checkout:

```sh
node scripts/run-test-aggregate.mjs all --shards=16 --workers=4 --require-clean --fail-on-skipped
npm run poc:release-gate -- --continue-on-failure
```

Diagnostic continuation collects failures; it never changes a failed gate into a successful one.
Do not remove platform skips, lower budgets or discard recovery merely to produce a green receipt.
