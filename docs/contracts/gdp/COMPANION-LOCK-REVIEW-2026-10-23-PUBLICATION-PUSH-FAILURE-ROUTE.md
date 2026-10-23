# GDP companion authority review — A failed publication push names the sync that finishes it — 2026-10-23

Review boundary: `507ade77b65e3641596ef36ca0c131708875a38e` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-23-WORKFLOW-BUNDLE-V10-USER-DEFINED-FOLDERS.md`.

One GDP-locked companion changes in this change: `publication-unit-of-work`. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `src/publication-unit-of-work.mjs` (`publication-unit-of-work`)

- **What changed:** only the error thrown when a lifecycle publication's commit is retained locally but its push fails (publication mode `required`; `warn` still returns a pending result).
  - Before, the message ended "Run the appropriate sync command", with no code and no details unless a local hook failed. Recovery plans therefore offered `--help`, `doctor` or `phase show`. For `approve` the plan said to end the approval turn and use `/sf-reject`, although the approval was already committed and only the push remained.
  - Now the message names the exact command: `singularity-flow sync <WORK-ID>` for a Story, `singularity-flow initiative sync <ID>` for an Initiative, and the old sentence for any other subject. The same command is in `details.nextAction`, and the hook-failure details (`remoteFailure`, code) are kept as before.
  - The error carries `publicationRefAdvanced: true` and `publicationCommit: <the retained commit>`. That is what happened: the branch holds the commit and only the push failed. It sends the error to the existing "finish publication" recovery route in `src/refusal-remediation.mjs` (`sync`, then `recover`), which never authors again.
- **Who reads those two fields, and why setting them is safe:**
  - `src/refusal-remediation.mjs` uses them only to choose that recovery route.
  - `src/local-identity.mjs` uses `publicationRefAdvanced` to keep, rather than discard, a Story-start reservation whose commit exists. That is correct here: the reservation's commit is on the branch.
  - `src/editor.mjs` reads it only for its own configuration commits, which do not go through this unit of work.
  - Inside this unit of work, the flag gates `unwind` only in the commit stage's own `catch`, which this push-stage error never enters. The journal, pending-publication marker and ledger handling before the throw are unchanged.
- **What did not change:** what is committed, the journal stages (`push-rejected` / `push-indeterminate`), the pending marker, the push itself, the conflict strategy, the combined ledger push, and which errors are thrown.

Who approves anything is unchanged. Approval authorities, sequence gates and publication policy are untouched.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `publication-unit-of-work` | A failed push names `sync <WORK-ID>` (or `initiative sync <ID>`) in its message and `details.nextAction`, and marks the retained commit (`publicationRefAdvanced`, `publicationCommit`) so recovery routes the sync that finishes it. | `sha256:443f59dcd45fbad7f2fc968985da63b58e5d2d148aef5a182c3d668ddc8541db` | `sha256:bbff2a3a9cc255c7c697fa45862e1be57bf92e74bb6a3944813e61e6f32ce807` |
