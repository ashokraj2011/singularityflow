# GDP companion authority review — approver refresh records — 2026-10-29

Review boundary: `6f0e9741db7f4f6cc9939d4ffdb2e3e8ee2d6f19` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-26-WORKFLOW-BUNDLE-V11-AGENT-FOLDER-BYTES.md`.

One GDP-locked companion changed: `migration-registry` (`src/schema-migrations.mjs`). No other locked companion drifted at the boundary. This is a bounded review of two new record families. It is not a bulk hash refresh, and it adds no approval authority.

## Reviewed in `src/schema-migrations.mjs`

- Two new immutable families at version 1, with no migrations:
  - `approver-refresh-decision`, at `context/approver-refreshes/APR-NNN-decision.json` in a Story: the reviewed decision of `story approvers refresh`. It binds the exact accepted parent snapshot and policy, the refreshed policy digest, the members added to each existing group, the configuration ancestry proof from the Story's configuration commit to the approved one, and the person who recorded it with their group and live-terminal authorization.
  - `approver-refresh-summary`: the append-only summary that decision leaves in the Story's `approverRefreshes` list.
- Neither family changes who may approve. A refresh only carries into a running Story members that the approved configuration already lists in groups the Story already has; the configuration change itself is governed as before. Removals, new groups and group rules are never applied, and the person recording a refresh must be in one of the refreshed groups.
- Each accepted refresh is one workflow snapshot revision with dialect `approver-refresh/v1`, replayed in the accepted chain (`src/workflow-snapshots.mjs`): the decision must bind its exact parent, only member additions may differ (`assertApproverRefreshScope`), the ancestry proof must verify, and the acceptance commit may change no application source.
- Existing Stories are unaffected until a person records a refresh.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | `approver-refresh-decision` and `approver-refresh-summary` families at version 1. | `sha256:28386f08262252a675692db049015e2be323151a7b3306225514f437144c3709` | `sha256:42fd772fad7125b5f8bcf5173011dc7916c0211a51d6414ccfd7f28c5d2b85ab` |
