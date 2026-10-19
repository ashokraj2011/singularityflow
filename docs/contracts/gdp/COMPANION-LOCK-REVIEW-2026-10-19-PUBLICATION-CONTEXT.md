# GDP companion authority review — publication read context — 2026-10-19

Review boundary: `8322711c4453bfa04baf888528d70c2bb04e4005` (`main` at this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-19-TYPESCRIPT-PLAYWRIGHT.md`.

One GDP-locked companion changed without a review: `publication-unit-of-work`, in `1078bf60` ("Isolate publication writers and share bounded immutable transaction reads"). This review covers that change after the fact. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `src/publication-unit-of-work.mjs` (`publication-unit-of-work`)

The change is 7 lines added and 6 removed, in three places:

1. **The transaction body runs inside `withPublicationContext(root, …)`**, imported from the new `src/publication-context.mjs`.
   - The subject lock is still taken first: `withSubjectLock` stays the outer call, and the context opens and closes inside it. Lock scope and lock owner are unchanged.
   - `withPublicationContext` is `try { return await contexts.run(frame, action) } finally { clear the frame }`. It returns the body's own result and rethrows the body's own error. It catches nothing and converts nothing.
   - The context only lets `publicationGitRead` share bytes between reads inside this one publication. Its only caller is `gitResult` in `src/sgos/candidate-lifecycle.mjs`, used when an SGOS candidate is published.
   - Only one read form is ever shared: `git ls-tree -z <OID> -- <paths>`, where `<OID>` is a full object ID and every path is a plain literal. That reads content-addressed objects, which cannot change.
   - A shared read is forced to `GIT_NO_REPLACE_OBJECTS=1`, `GIT_NO_LAZY_FETCH=1` and `GIT_LITERAL_PATHSPECS=1`. Reads are never shared:
     - with a relocating Git environment (`GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, `GIT_OBJECT_DIRECTORY` or alternates);
     - with input on stdin, from another root, or after the context closed;
     - for results that are not buffers (failures are never cached);
     - beyond 256 entries or 32 MiB.
   - HEAD, refs, the index, identity, configuration-dependent diffs and live files are never shared, as the module's header says.
   - `test/publication-context.test.mjs` pins all of this. Its five tests cover: sharing only inside one publication, and never sharing caller-owned buffers; refs, worktree and index reads, input, relocating environments, limits and failures never being reused; only the exact disabled-hooks override counting as equivalent; independent bounded contexts for parallel and nested publications; and the publication gateway never statically loading the legacy authoring, approval or model owners.
2. **The recovery preimage capture is wrapped in `measureCommandSpan('publication.recovery-capture', …)`.**
   - The expression inside is unchanged: the supplied preimage, else `state.captureRecovery()`, else `capturePublicationPreimage(...)`. It is awaited exactly as before, so `recoveryPreimage` receives the same value.
   - It still runs before the journal begins, so the order "persist the pre-transaction bytes before the journal authorizes the first state write" is unchanged.
3. **`beginPublicationJournal(...)` is wrapped in `measureCommandSpan('publication.journal-begin', …)`** with the same arguments: subject, expected head, branch, paths, pending metadata, transaction ID and lock owner.

`measureCommandSpan` runs the action directly when no command timer is active. Otherwise `timer.measure` returns `await action()` and only adds the elapsed time in a `finally`. Errors pass through unchanged.

A span name prints a progress line only when `SINGULARITY_FLOW_PROGRESS=stderr-v1` is set and the name matches `start.*` or `publication.(preflight|discovery|validation|commit|push)`. Neither new name matches, so the change prints nothing new.

The file already measured six spans in this same transaction: state write, admission, candidate, commit, and push twice. Two more spans add no failure mode the transaction did not already have.

Unchanged:

- lock acquisition and release;
- branch and head checks;
- preimage capture, journal, state write, admission, candidate freeze, commit and push, all in their original order;
- rollback and restoration on failure;
- the published outcome and its record shapes.

Who approves anything is unchanged.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `publication-unit-of-work` | Transaction body runs inside the bounded immutable-read context; recovery capture and journal start are timed. | `sha256:40c741224e7cc4d89a1b4171b692527bbc1cb89aff8e89ec8a15d875c8d42af0` | `sha256:443f59dcd45fbad7f2fc968985da63b58e5d2d148aef5a182c3d668ddc8541db` |
