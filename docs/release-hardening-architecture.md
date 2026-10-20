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

## Explicit MCP setup

Windows host attestation and warm-up may secure a legacy MCP container after explicit confirmation
or network consent. Only the container's ACL changes; retained data is not traversed. Topology and
the resulting ACL are reverified. Doctor/readiness never repair permissions implicitly.

## Prompt-file staging

The source directory entry is checked before opening and rebound after reading. Descriptor identity
uses BigInt file IDs, including on Windows where `O_NOFOLLOW` may be unavailable. Symbolic links,
replacement races and writes during staging are refused before a prompt snapshot is handed off.

## Qualification and recovery ownership

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
