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
