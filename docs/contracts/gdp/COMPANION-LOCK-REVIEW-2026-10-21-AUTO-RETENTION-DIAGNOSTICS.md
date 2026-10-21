# GDP companion authority review — Auto retention diagnostics and clone completion — 2026-10-21

Review boundary: `275abcb0000e435750e465cff48d098bad943856` (`main` at this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-20-LOCAL-DOCUMENTS-AND-TRACES.md`.

Two GDP-locked companions changed without a review, so the lock failed on `main`:

- `candidate-custody` (`src/auto/auto-candidate.mjs`), in `6f218074` ("Preserve bounded Git diagnostics when Auto retention fails");
- `migration-registry` (`src/schema-migrations.mjs`), in `6e6824f3` ("Retain completed workspace clones and resume lock-contended folder claims").

This review covers both changes after the fact. It is not a bulk hash refresh, and it adds no authority. Every other companion still matches its accepted digest.

## Reviewed in `src/auto/auto-candidate.mjs` (`candidate-custody`)

The change touches two refusals: the one for a failed push of the Auto Candidate recovery authority (`publishAutoCandidateRecoveryAuthority`), and the one for a failed push of the retained candidate (`publishAutoCandidateAuthority`).

- **What changed:** the two refusal messages now end with `gitFailureDiagnostic(pushed)`, the push's output, so a person can see why the remote refused. Before, they said only that the remote could not retain the candidate. The import of `gitFailureDiagnostic` from `src/git-remote-diagnostics.mjs` is the only other change.
- **The diagnostic is redacted and bounded.**
  - `gitFailureDiagnostic` redacts each stream with `redactDiagnosticText` before cutting it to 4,096 characters, so a bound cannot split a secret and leak part of it.
  - It is the established form: six other refusal sites already use it.
  - Credentials and tokens are removed the same way as for every other Git refusal.
- **Nothing else changed:**
  - the refusal code (`AUTO_CANDIDATE_REMOTE_PUBLICATION_FAILED`) and when it is thrown;
  - the pushed commit and ref, and the retained recovery ref;
  - the custody checks before the push, and what recovery does after a refusal.
- **Approval:** no approval, candidate choice or publication decision reads the message. Who approves anything is unchanged.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

The change is one added line: `family({ id: 'workspace-clone-completion', currentVersion: 1 })`.

- **What it registers:** a machine-local, version-1 family with no migration step and no path pattern.
  - `src/workspace-clone-claim.mjs` writes it once as `.sflow-clone-complete.json` in a workspace clone's staging folder (create-only, mode 0600) after the clone finishes.
  - A later claim reads it explicitly with `readRecord`, together with the staging folder's owner record, to resume a lock-contended folder claim instead of cloning again.
  - It lives outside every repository and is never committed.
- **What registration does:** it fixes the schema version, so `readRecord` reads a version-1 record and refuses a newer one. The golden catalog lists version 1.
- **What it grants:** nothing. It records that a clone finished; no approval, publication or Story state reads it.
- **Everything else is unchanged.** No other family changes its version, steps, paths or immutability.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | The `workspace-clone-completion` version-1 family. | `sha256:788df5337b1fe8bdae3a156ccb2de80ee4acdf14df08906d337688cb61ec2770` | `sha256:3e5a95c3416eff77bf5643d9a652664ef8c416540e50ed6c24514294787b5440` |
| `candidate-custody` | Two remote-retention refusals carry the redacted, bounded Git diagnostic. | `sha256:8dca4ae7661c33ea4d4ba4baaa9488243f7457341d5a8e037a9c3ddd3a303443` | `sha256:03b1245b4a315a452c1d8e3c339214af53fd815011ab4299673a5f47ce210f5d` |
