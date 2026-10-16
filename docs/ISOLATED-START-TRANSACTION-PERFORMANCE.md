# Isolated Story configuration and publication transactions

This change starts from `ae262803a972d1eca5d70d200273097218f7605f`. It targets
the backing CLI path used by VS Code isolated creation, particularly a cold Windows request
that also enrolls a new Git identity. No model is invoked by the measurements.

## Implementation

- An asynchronous, operation-local owner retains the first verified direct-configuration clone
  until isolated creation finishes. Only the actual snapshot object can consume its checkout,
  once, in that same owner. Remote identity, exact parent, retained bytes and a clean checkout
  are checked before reuse. Concurrent starts cannot borrow each other's leases.
- Enrollment reuses that checkout when available. Otherwise its ordinary disposable-clone path
  remains available, including when the existing POSIX configuration object store supplied the
  original snapshot. Windows persistent caches remain unchanged and optional.
- After successful enrollment publication, the exact committed successor and parent are checked,
  and the existing full snapshot validator captures the new configuration. A private WeakMap
  attaches this snapshot to the actual enrollment result; serialized result data cannot forge it.
  Start still freshly resolves approved authority and must match that successor before using it.
  The disposable checkout never becomes a persisted authority or a reusable cross-command cache.
- Draft and publication boundaries read HEAD plus branch in one fresh Git invocation. Exact-tree
  admission resolves both tree identities through one bounded `cat-file --batch-check` invocation.
  Missing objects, a non-tree candidate, detached HEAD, ref movement and Candidate drift still
  refuse; commit compare-and-swap and synchronous exact-tip publication are unchanged.
- Added spans separate enrollment refresh, configuration capture, materialization and consumer
  binding. These are nested operation spans, not additive to their parents.

The transaction disposes its owned scratch checkout on success or failure. A cleanup error is
reported as a warning rather than turning an already-published Story into a failed start or
masking the original refusal. No user index, worktree, approval or unrelated checkout is removed.

## Qualification boundaries

Regression tests cover exact successor binding, stale authority refusal, forged/serialized
handoffs, one-use leases, retained-byte tampering, concurrent owners, failure cleanup, unchanged
application index/HEAD, fresh branch reads, detached HEAD and missing/wrong-type Git objects.
Existing publication fault, rollback, linked-worktree, secret-admission and Candidate tests run
against the shared publication changes.

The gateway bundle's reviewed cap increases by 3,000 bytes to 7,508,000 for the transaction
ownership/validation helpers. The activation entry, activation module count, total budget and
other entry caps are unchanged. The two new read-only configuration-owner Git sites are reviewed
in `git-bypass-audit.md`; no registered owner or general execution permission is added.

A broad configuration-suite run exposed an existing state-mirror resume failure:
`SESSION_REPOSITORY_NOT_GOVERNED` in the test named “Story start recovers from a verified state
mirror when sflow/config is unavailable”. The unchanged baseline reproduces the same failure in
its later resume assertion. It is not classified as a new regression or silently counted as a pass.

Local validation passes 52 configuration tests with that named baseline failure excluded;
135 publication/preflight/Candidate/isolation tests; 84 Git/materialization/audit tests; and
13 targeted publication/Epic/timing tests. These sets overlap, so they are not summed into a
unique-test count. The aggregate source check passes 2,618 checks; TypeScript and bundle checks
also pass.

## macOS cold comparison

The [retained macOS report](../benchmarks/story-creation/transaction-macos.json) measures the final
three alternating fresh-repository pairs on a shared desktop, not an exclusively reserved host. On this arm64 Mac,
Node v25.5.0 / Git 2.54.0, complete creation/publication improves from 3,222 ms to 2,953 ms median
(about 8.3%). Candidate runs range 2,928–2,964 ms; controls range 3,212–3,473 ms.
Git launches fall from 198 to 183, with one configuration snapshot read instead of two and no
post-enrollment transfer. The existing POSIX object cache still supplies the initial snapshot,
so its enrollment uses the ordinary scratch checkout while retaining the successor in memory.
First feedback is effectively unchanged: the primary gain is transaction completion, not UI paint.

An earlier [exploration](../benchmarks/story-creation/transaction-macos-exploration.json), while
regression tests also ran, is retained separately and is not mixed into the final distribution.

## Native Windows validation

CI run `38938349361` passes the final-source smoke at `6843b69f`: six configuration transaction
tests, seven publication tests, type checking, bundle limits and a fresh 1,000-file isolated start
with exact local/remote tip verification. The [raw smoke](../benchmarks/story-creation/transaction-windows-smoke.json)
is one unpaired sample and must not be treated as a performance distribution. Runtime is Windows
x64, Node v24.21.0 and Git 2.56.0.windows.2. It records one configuration clone, one owned-checkout
reuse, one captured enrollment successor and a 0.1 ms successor handoff.

Initial CI runs `38937304125` and `38938066926` exposed portability problems in existing test
fixtures before benchmarks ran. The publication subprocess probe now imports a proper file URL
on Windows. POSIX process-kill and executable-mode fixtures, and a literal-question-mark filename
fixture, have explicit platform exclusions; the directory-recovery test still runs byte recovery
and bounded rescue retention on Windows without asserting unavailable POSIX mode bits. The CI
uses the same short temporary root for both variants so deep ref-name fixtures fit Windows path
limits. No production permission, authority or long-path policy was relaxed.

## Reproduction

With dependencies installed, compare fresh repositories and fresh compile caches, alternating
candidate and baseline with the same installed packaging:

```sh
node scripts/story-creation-benchmark.mjs --mode=isolated --fresh=true --configuration=approved --samples=3 --files=1000 --control-ref=ae262803a972d1eca5d70d200273097218f7605f --out=transaction-cold.json
```

A 10,000-file paired smoke uses `--samples=1 --files=10000`; one pair is not a distribution.
The fixture uses a local bare remote, validates the exact published Story tip, runs no tests or
models during intake, and cleans its own repositories. It does not measure office antivirus,
enterprise authentication, network latency, native VS Code painting or Copilot tool round trips.
