# GDP companion authority review — failed Git reads in Candidate custody — 2026-09-29

**Review boundary:** `main@c241767ba7358ba67f1cf2e6c62d862d5df5c6a7` plus the exact failed-Git-read patch reviewed below. The previous review is `COMPANION-LOCK-REVIEW-2026-09-29-STORY-INTAKE-RECEIPT.md`.

Exactly one GDP-locked companion changed. `candidate-custody` now tells a Git answer apart from a Git read that did not happen. No accepted Candidate state, refusal for a genuine Git answer, record family or authority changed. This is not a bulk hash refresh or a new approval authority.

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `candidate-custody` | Eight reads that decide Candidate custody used to read a failed Git command as an empty answer. The retained tree, the recovery authority's parent and binding, and the fetched Candidate tree now use `rev-parse --verify --quiet`, so Git's clean "absent" still takes the existing `AUTO_CANDIDATE_RETENTION_LOST` or `AUTO_CANDIDATE_RECOVERY_CORRUPT` refusal. `FETCH_HEAD`, the recovery tree listing and the Candidate-bytes listing for verification evidence paths must succeed. Any other failure refuses with `AUTO_CANDIDATE_GIT_FAILED` and Git's first line of error, instead of reporting a lost Candidate, a corrupt recovery authority or a lost remote. A failed listing can no longer admit a verification evidence path that overlaps immutable Candidate bytes. | `sha256:b60dca7ed3449076852a9bc56f104997cc09849ceac8c86c568282b5350342c0` | `sha256:564bdc9ec2cd0fb11c8ff73b2c9649d5e845f2eaf0259c3dd1e3eb28f694eb7c` |

What is accepted as custody is unchanged: the same retention ref, tree, parent, binding and closed recovery tree are required, and every refusal Git's own answers produced before is still produced. The only new outcome is a refusal for a read Git did not complete. Both digests were computed from the file bytes at `main` and in the patch, not copied from a failing assertion.

Validation at this boundary: the Auto Candidate and Candidate crash-recovery tests and the failed-Git-read tests passed. The GDP companion-lock suite must pass against this exact accepted digest.
