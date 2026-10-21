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
Native macOS/Windows qualification and the latest-main merge recheck are required before delivery.
