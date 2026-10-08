# GDP companion authority review — local hook publication and new record families — 2026-10-09

Review boundary: `94ed35919ef19805c50b2973260a0ba7e04ea08a` plus the hook-hint classification fix reviewed below. The preceding review is `COMPANION-LOCK-REVIEW-2026-10-05-SKILL-MASTER.md`.

Five GDP-locked companions differed from their accepted digests at the boundary, so the lock failed on `main`. This review covers two of them after the fact: `publication-unit-of-work` and `migration-registry`. It does not accept `action-authorization` (see "Drift not accepted" below). It leaves `workflow-configuration` and `world-model-v4` to their own bounded review. It is not a bulk hash refresh or a new approval authority.

- `src/publication-unit-of-work.mjs` was accepted at `sha256:e9f00207…` (the `3b683ef3` bytes). `b8b7c5ca` changed it. At the boundary its digest is `sha256:91ce95ee66f799798de11264c023a39e05f7c05927bf55b8efa1d235e0c748b4`.
- `src/schema-migrations.mjs` was accepted at `sha256:c54dcba9…` (the `88495a07` bytes). These commits changed it:
  - `cd198ea9`, merged with `88495a07` in `735d5de6`;
  - `b8b7c5ca`, `a730292e`, `288abd39`, `311c5b5a`, `69b9e9e5` and `b2329a4b`.

  At the boundary its digest is `sha256:0e6df671b05046e9c08e57ce958e4dc57935318546bec3a0e013e02b16bb206b`.
- `src/action-authorization.mjs` was accepted at `sha256:63de1360…` (the `4e0942da` bytes). `59c88c23` and `1c0f1d2d` changed it. At the boundary its digest is `sha256:ecf788b638cbc305cfb598c2b6013e1569c479499cc84c9f7eec27fb636195df`. That digest is not accepted.

## Reviewed after the fact in `src/publication-unit-of-work.mjs`

`b8b7c5ca` ("Fix review findings and add collision-safe workflow import and duplication") changes two places in the publish stage.

- **A local hook refusal is this attempt's result.** The combined push sends the lifecycle branch, its ledger entry and the pin in one atomic push. When a local `pre-push` hook fails that push, `publishBranchWithLedgerEntry` now returns `hookRejected` with the push result. The unit of work uses that result instead of pushing the branch alone. The sequential fallback would only run the same broken hook again. Git runs `pre-push` before it sends anything, so a hook refusal lands no ref.
- **Recovery is unchanged.** The result takes the existing failure path:
  - `publicationPushOutcome` classifies it: `rejected`, or `transport-indeterminate` after a timeout or signal.
  - The exact commit is kept as a pending publication, bound to its transaction, event and state digests, and the journal is cleared.
  - `warn` mode still returns the pending result, and the other modes still throw.
  - A conflict strategy still runs only after a definite (not indeterminate) outcome.
- **Refusal text and code.** After a hook failure, the error tells the person to repair the local hook or runtime, not remote access. It carries `code` (`REMOTE_LOCAL_HOOK_FAILED` or `REMOTE_LOCAL_HOOK_TOOL_UNAVAILABLE`) and `details.remoteFailure`, which holds:
  - the classification, its code, retryability and advice;
  - exit evidence: status, signal, timeout, and only a digest and byte count of the raw output;
  - the hook marker: hook, line and missing tool;
  - both output streams, redacted and bounded to 4,096 characters each;
  - the Git-visible paths that changed during the push, redacted, at most 50.

  Only redacted, bounded diagnostics leave this unit of work, as before.
- **What still holds.** The exact commit, the ref leases and the published refs are unchanged. There is no new publication mode and no automatic file cleanup.

### Hook-hint classification fix (this change)

The unit of work now relies on `localGitHookFailure` in `src/git-remote-diagnostics.mjs`, which is not a companion.

- **The defect.** `localGitHookFailure` took any output line that was not a `remote:` line and named `.git/hooks/pre-push` as a hook marker. When that hook exists but is not executable, Git prints its own advice before every push:

  `hint: The '.git/hooks/pre-push' hook was ignored because it's not set as executable.`

  In such a repository every push failure was classified `local-hook-failed`: a stale lease, failed authentication, or a dropped connection after the remote had accepted the update.
- **Its effect on publication.** A dropped connection without a timeout or signal was recorded as a definite `rejected` outcome. Recovery may reconcile exact remote equality only from an indeterminate outcome, never from a known rejection. In the combined path, the failure also skipped the remote observation that reports a landed but unacknowledged push as `uncertain`.
- **The fix.** The classifier ignores Git's `hint:` lines, as it already ignored `remote:` lines.
- **Reproduction.** The defect reproduces with Git 2.54.0. The new test in `test/git-hook-publication.test.mjs` does a real push with a non-executable hook and fails without the fix. The companion's bytes do not change.

## Reviewed after the fact in `src/schema-migrations.mjs`

- **`workflow-bundle` moves from schema 5 to 7.**
  - `b8b7c5ca` adds the step 5 → 6, which only sets the version. Version 6 lets a bundle carry the integration targets (`objects.story.integrations.targets`) that its workflows' after-step actions name. The reader refuses that section in a bundle older than 6, so the projection invents none.
  - `288abd39` adds the step 6 → 7, which sets `workflowSkillAttachments: []`. Version 7 carries each workflow's complete skill attachment set, including a set that is intentionally empty.
  - **The projected empty list is not a claim.** The transfer reader takes only `storedVersion` from the registry, then validates and returns the stored bytes. The import plan compares workflow attachments only when the stored bundle has the field. So an older bundle never removes or replaces target-local attachments. This review checked it directly: re-sealed as v6, a v7 export with an empty set imported with no attachment operation, and the target's `attachments.yml` stayed byte-identical. The same content as v7 waited for a person's choice on `workflow:mobile-release`.
  - The family stays immutable. Historical bundles keep their stored identity and `bundleSha256`, and the golden catalog lists versions 6 and 7.
- **Four immutable version-1 families with no migration step.**
  - `phase-repair-loop-event` (`a730292e`) and `phase-continuation-event` (`69b9e9e5`).
  - `phase-appeal` and `phase-appeal-decision` (`a730292e`). They own `work-items/<id>/appeals/APL-<24 hex>/packet.json` and `decision.json`, paths that no other family claims.

  Registration lets the registry read these records and refuse an unknown version, and it grants nothing. `src/phase-appeals.mjs` enforces what an appeal decision may account for, through the plan approval authority, and this review accepts nothing about that.
- **Three machine-local version-1 families.**
  - `copilot-mode-preference`: `$local/copilot-mode.json`, from `cd198ea9`, merged in `735d5de6`.
  - `presentation-profile`: `$local/presentation-profile.json`, from `311c5b5a`.
  - `copilot-repository-boundary`: `$local/copilot-boundaries/<64 hex>.json`, from `b2329a4b`.

  Registration only fixes their schema version. Their own modules decide what they mean: the Copilot pause, a display name, and which repository an explicit SFlow Copilot turn is bound to. They live outside any repository.
- **Everything else is unchanged.** No other family changes its version, steps, paths or immutability.

## Drift not accepted: `action-authorization`

- `59c88c23` moves the terminal review card and prompt from stdout to stderr.
  - The reason: a `--json` caller's buffered stdout hid the card while the prompt waited.
  - It now also requires stderr to be a TTY.
  - It trims the answer, and a wrong answer gets two more tries. Enter still cancels at once.
  - The typed label must still match exactly.
- `1c0f1d2d` adds `captureEvidenceReviewAuthorization`, a second channel for presenting the review.
  - It applies only to an evidence-contract correction (`PEA-…`).
  - The CLI serves a one-shot page on 127.0.0.1 with a secret path, a nonce, same-origin checks, a CSP and a 15-minute limit. It opens the page in the default browser and issues the authorization when the person types `Correct evidence PEA-…` there.
  - `consumeActionAuthorization` gains `requireEvidencePresentation`. It accepts only this channel, only for a `PEA-` action with an evidence-correction preview.
  - The decision records `reviewAssurance: live-local-ui-exact-evidence-review`.
  - The correction preview now returns the `--review-ui` command as `copilotCommand`. Its human review changes from `surface: human-terminal`, `execution: human-relay-only` to `surface: local-browser`, `execution: human-mediated-review`.
- **Why this review does not accept it.**
  - Before, only a person at a direct terminal could complete this authorization, and Copilot was told to relay the command to that person. Now Copilot runs the acceptance command itself, and consent arrives through a new channel that this companion issues grants for.
  - That widens the consent surface this companion governs. It needs a bounded review that sanctions the channel, not an after-the-fact reconciliation.
  - Like the terminal route, the browser page is configured local review. Its origin and nonce checks stop cross-site requests. They do not stop a local process that learns the one-shot URL, for example from the arguments of `open` or `xdg-open`, or from browser history. The commit's own documentation says the same.
- The lock keeps `sha256:63de1360…`, so the companion-lock test keeps failing on `action-authorization` until that review lands.

## Reviewed drift

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `migration-registry` | `workflow-bundle` 5 → 7, which adds integration targets and complete workflow skill attachment sets, without projecting either onto older bundles. Four immutable version-1 phase families and three machine-local version-1 families. All as above. | `sha256:c54dcba9a46bc6386b4abfe7e8d32647354eccd96f8f659675e4f87dd0fcb8e7` | `sha256:0e6df671b05046e9c08e57ce958e4dc57935318546bec3a0e013e02b16bb206b` |
| `publication-unit-of-work` | A local `pre-push` refusal of the combined push becomes the attempt's result, with no sequential re-run of the hook. Hook-specific refusal text, code and redacted, bounded details (`b8b7c5ca`). All as above. | `sha256:e9f00207cf5a2422787e709d17e0f34fd389a2362cdead1419644e91d148888c` | `sha256:91ce95ee66f799798de11264c023a39e05f7c05927bf55b8efa1d235e0c748b4` |

The accepted changes grant no approval, import, overwrite or publication authority.

## Validation evidence

All runs used `SINGULARITY_FLOW_NO_MODEL=1`, `SINGULARITY_FLOW_DISABLE_TIMING_LOG=1` and throwaway machine state. The owner tests ran in one batch with the classifier fix in place. That batch covered these suites:

- **Publication:** `git-hook-publication`, `git-remote-diagnostics-classification`, `git-remote-boundary`, `git-execution`, `ledger`, `publishing`, `publication-faults`, `publication-guidance-contract`, `publication-linked-worktree`, `publication-preflight`, `story-start-publication`, `environment-publication-recovery`, `sgos-universal-candidate-publication`, `workspace-bootstrap`, `configuration-proposal`.
- **Migration:** `mig-golden`, `mig-read`, `mig-lint`, `mig-doctor`, `workflow-transfer`, `workflow-transfer-cli`, `workflow-transfer-conflicts`, `phase-appeals`, `phase-repair-loop`, `phase-continuation`, `copilot-repository-boundary`.
- **Action authorization (not accepted):** `action-plans`, `action-terminal-confirmation`, `local-evidence-review`.

Results:

- 724 tests ran: 722 passed and 2 failed. Both failures also fail on unmodified `94ed3591`:
  - `mig-read` "historical workflow bundle projections keep stored identities without inventing strict closure" still expected schema 5. This change pins the accepted v7 projection: steps through 6 → 7, `workflowSkillAttachments: []` as the only added default, and no projected integration targets. `mig-read` and `mig-golden` now pass 30 of 30.
  - `sgos-universal-candidate-publication` "capability sibling transport verifies the exact Candidate before its push" is a source-shape assertion about `src/capability-start.mjs`. That file is not a companion, and this change does not touch it.
- `git-hook-publication` passes 7 of 7. Its new ignored-hook test fails on the unfixed classifier (`expected: 'network-transient'`, `actual: 'local-hook-failed'`).
- The v6 attachment behaviour was checked with a throwaway import test, which was not kept. It passed.
- The GDP contract-freeze companion-lock test still fails, on `workflow-configuration` first, because three companions remain unaccepted. With those three temporarily pinned to their boundary digests, all five freeze tests pass, so this review's `lastReview`, boundary line and rows satisfy the test. The lock was restored before commit.
- `node scripts/check.mjs` passes.

## Sanctioned reconciliation procedure

1. Hash every `companions[].path`, and confirm that the drifted companions at the boundary are `workflow-configuration`, `world-model-v4`, `publication-unit-of-work`, `action-authorization` and `migration-registry`.
2. Verify that a local hook refusal of the combined push still lands nothing, and that Git's ignored-hook hint no longer turns a push failure into a hook failure.
3. Verify that `workflow-bundle` stays immutable, that its golden catalog lists schemas 6 and 7, and that historical projections keep their stored identity.
4. Run the tests listed under "Validation evidence".
5. Accept only the two digests reviewed above. Leave `action-authorization`, `workflow-configuration` and `world-model-v4` at their previous digests, and keep `baselineCommit` unchanged.
6. Require another bounded companion review for any later byte change to these companions. `action-authorization` needs a bounded review that sanctions the evidence browser channel before its digest is accepted.
