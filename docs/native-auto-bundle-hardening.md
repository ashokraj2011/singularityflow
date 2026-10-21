# Native Auto submission and bundle hardening

## Failure and fix

The Ad Hoc-to-Auto Candidate could publish successfully on Windows and then refuse submission
with a stale code/test-input binding. Dirty files were hashed as raw worktree bytes, while clean
files used committed Git object IDs. Git's CRLF conversion made publication invalidate its own
receipt. Windows also needs the index's tracked executable mode, not a synthesized filesystem bit.

Source and separately hashed test inputs now use one read-only Git object-hash batch for dirty
regular files. Git applies its built-in EOL/encoding conversion; external clean/process filters
are disabled from one fresh policy snapshot. No object writes, staging, history scan, network call
or per-file Git child is introduced. Real code/test-input changes still invalidate the binding.
Binary and explicit `-text` bytes remain significant. Existing clean receipt identities stay intact.
Previously retained stale receipts are not rewritten or retroactively attested: existing blocked
flights still use their governed recovery/revalidation route to obtain fresh evidence.

The end-to-end adoption regression enables `core.autocrlf=true` on every host. Focused cases cover
SHA-1/SHA-256 repositories, executable mode, Unicode paths, UTF-16, binary bytes, independent test
inputs and non-execution of repository filters. Tests verify that hashing changes neither the
index nor the object store.

The wider native cohort also checks Candidate isolation. Windows `fs.cp` can turn a dependency
junction into a normal directory containing excluded working-tree bytes. Isolation now discovers
and validates links in the original tree, skips those paths during copying, then creates links
only into the candidate. This avoids copying excluded dependency content before rebinding and
keeps the original checkout untouched. The native test executes both copies and mutates the
candidate dependency to prove it cannot write back into the original.

Portable fixtures set executable modes in the Git index, enable long refs only on their own
disposable test server, and use an unhashable tracked path instead of POSIX permission bits.
Byte-exact Candidate/approval fixtures explicitly declare LF. They do not qualify arbitrary
CRLF-rewritten managed Markdown; the separate source-binding and Auto adoption tests retain
native CRLF conversion.

## Bundle fixes

All original byte/module ceilings remain unchanged. No source maps or modules are hidden from
measurement, and no dependency is added.

- The existing tiny process-wide context entry owns one managed-engine resolver. Activation and
  lazy panels reuse it, but each lookup still freshly reads the current installed runtime/CLI pair.
  Invalid installation selections remain errors, not a fallback to a stale engine.
- The ACP SDK loads only when a model session starts, resolved from SFlow's locked package. It is
  no longer embedded in the gateway used for read-only cards. A packaged CommonJS regression
  executes the actual SDK protocol and rejects an unrelated application-cwd dependency.
- UI consumers project the trusted, frozen built-in authoring catalog without embedding its
  untrusted-input parser. The audit and tests validate that literal and require exact equivalence;
  imported/user declarations still pass the full parser.

## Qualification

Baseline: fresh main `f0abdbc783dfd233b5ed379392cd762e8ae3374a`.
The final pre-merge fetch still resolves main to that same commit; no upstream integration is
omitted. Product changes are in `5c6df7fa` and `b07a50e7`; native fixture corrections are in
`7ff1d34d` and `2176f040`.

The 54-case Auto lifecycle corpus passes on this Mac and on native Windows Node 26. Windows run
`39589790891` partitions only registration into four jobs (14 + 14 + 13 + 13); the retained selection
manifests prove an exact union of all 54 unique names/indices with zero failures or skips. Its first
broader Windows cohort exposed the portability/isolation issues described above; those failures
are not reported as a clean initial run. Native junction diagnosis is run `39590575970`.

The final source/Candidate/provider/authoring cohort in run `39591814615` passes 128 tests on each
Mac Node version and 125 on each Windows Node version. Windows retains three pre-existing
platform exclusions: two POSIX file-symlink permission probes and the POSIX SIGTERM-ignore probe.
Its Windows editor cohort then exposed three test-only imports using bare drive-letter paths.
Those imports now use file URLs; no product assertion is removed.

The final editor/adoption/budget recheck, run `39592571647`, passes all four native jobs:

| Host | Node | Editor/client/gateway tests | Exact adoption publish + submit | VS Code budgets |
|---|---|---:|---:|---:|
| macOS | 22 | 344 passed | 1 passed | 13/13 passed |
| macOS | 26 | 344 passed | 1 passed | 13/13 passed |
| Windows | 22 | 344 passed | 1 passed | 13/13 passed |
| Windows | 26 | 344 passed | 1 passed | 13/13 passed |

All these final editor/adoption cases have zero failures or skips. Local macOS also passes the
54-case Auto corpus, 203 packaged extension-host fixture tests, the focused source/evidence
regressions, VS Code typechecking, and 2,945 static checks. No live model quota, human approval or
real workspace is used by this qualification. The temporary CI assets are not merged into main.

Local clean VS Code measurement (build stamps can change a few bytes):

| Runtime | Baseline bytes / modules | Fixed bytes / modules | Unchanged limits |
|---|---:|---:|---:|
| extension | 1,449,651 / 148 | 1,444,863 / 147 | 1,446,000 / 147 |
| gateway | 7,761,776 / 735 | 7,643,010 / 725 | 7,730,000 / 733 |
| lazy panels | 3,472,632 / 277 | 3,467,957 / 276 | 3,470,000 / 276 |

All 13 VS Code entries pass, including the small shared context entry at 6,458 bytes / 2 modules
against its existing 8,192-byte / 4-module ceiling. Packaging admits exactly the same entry list.

This is targeted bug/bundle qualification, not a full 1.0 release certificate. The broader CLI
bundle test independently fails its existing ordinary-JSON-status closure-size assertion on both
unchanged baseline main and this branch. That separate CLI budget is not raised or claimed fixed.
The existing platform-only symlink and POSIX SIGTERM test exclusions are also not release waivers.
