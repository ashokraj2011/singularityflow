# GDP companion authority review — repository commit policy, application review and task progress — 2026-11-05

Review boundary: `7e473c60eb143066cd716f5b304108f83ed2e707` (`main` at the start of this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-02-SF-GUARD-ADJUDICATIONS.md`.

Two GDP-locked companions drifted after that review with no review of their own, so the lock test had been failing on `main`: `publication-unit-of-work` (`4c79a2b8d`) and `migration-registry` (`6843eef50`, `4c79a2b8d`, `4f7fe7329`). This records what changed and why, from the diff of each file against its accepted bytes. No other locked companion differs at this boundary. This review changes neither file. It is not a bulk hash refresh, and it adds no approval authority.

## Reviewed in `src/publication-unit-of-work.mjs` (`publication-unit-of-work`)

All three changes come from `4c79a2b8d`, repository commit policy admission.

- **The commit call passes `commitPolicyContext`.** It names the subject, a purpose derived from the subject kind, the phase, the generation, the journal's transaction as the operation, and the expected remote when there is one. `src/git.mjs` hands these facts to `createRepositoryPolicyCommit`. In a repository with no commit policy that runs the same `commit-tree` as before, through `legacyCreate`. With an enforced policy they bind the owner-issued plan. They are identifying facts, not consent: nothing here approves a phase or waives a check.
- **Rollback keeps a ledger intent a hook edited.** `unwind` used to remove the intent file unconditionally. It now leaves it when the failure's `details.effects.changedPaths` names it, so a native hook's edit is not deleted silently.
- **A commit policy refusal says where the hook's changes went.** When rollback restored state and kept a rescue copy, an `RCP_` error gains `details.publicationRecovery` with `stateRestored`, `rescuePath` and `hookChangesPreserved`. Other errors are untouched.
- **Unchanged:**
  - the authority check and the expected-revision requirement;
  - the subject lock, the journal and its preimage;
  - admission and the Candidate;
  - the atomic branch, ledger and pin push;
  - the retained marker's fields and outcome;
  - cancellation and recovery.
- **Checked by:** `test/repository-commit-policy-owners.test.mjs`, `test/repository-commit-policy-runtime.test.mjs` and `test/repository-commit-policy-publication.test.mjs`, for the owner plan and its publication. No test names the kept intent file or `details.publicationRecovery`; those two were reviewed by reading only.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

Seventeen families were added, each at `currentVersion: 1` with no migration step. No existing family, version, step, path pattern or immutability flag changed.

- **`6843eef50`, opt-in application review:** `application-review-policy`, `-event`, `-session`, `-snapshot`, `-capture` and `-acceptance`. All are immutable except the session.
- **`4c79a2b8d`, repository commit policy:** `repository-commit-policy`, `-profile`, `-evidence`, `-object-binding`, `-discovery`, `-plan`, `-attempt`, `-object`, `-publication` and `-operation`. All are immutable except the operation. The evidence path is under `$state`, and the local records are under `$git`.
- **`4f7fe7329`, workflow task progress:** `workflow-task-record`, mutable, with `authority: 'progress-only'` enforced by its validator. It is never lifecycle evidence, consent, a lease or executable authority.

Registering a family grants nothing: it says how stored bytes are read. What each record may authorize stays with its own owner and the human steps that create it.

- **Checked by:** `test/mig-golden.test.mjs`, which reads a frozen record of every registered family to its current version, and `scripts/check.mjs`, which requires every family to have goldens.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | Seventeen new families at version 1: application review, repository commit policy, workflow task progress. | `sha256:86d02a68f3ed08ae0448431f3c0f4cccf971459fb4725da014b423c1fd1e5bfe` | `sha256:333fa1b274189858f19bd4e0d549b6015ca035da0d0a9cdb5798aa2628188d3a` |
| `publication-unit-of-work` | Commit policy context on the commit; a hook-edited ledger intent survives rollback; an `RCP_` refusal names its rescue copy. | `sha256:6cc1ff7c45e3b1d332a0186dc8e915426306f2c39a83999a3b13d03247594493` | `sha256:ef278fb532ff04e216d4d2cac62ebf2199d0ce1b285cb12c3184419048aeb4e8` |
