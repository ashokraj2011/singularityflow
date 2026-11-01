# GDP companion authority review — SF Guard M2, presence-signed approvals — 2026-11-02

Review boundary: `cc8ee90a5b6f6752c308832fedf5aa5f85cad3c9` (`main` at the start of this change, with SF Guard M1). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-01-SPEC-BACKUP-SPLIT-PROPOSALS.md`.

One GDP-locked companion changes in this change: `migration-registry`. No other companion differs from its accepted digest at this boundary.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- Changed: `phase-approval` goes from version 2 to 3 (SPEC-PSS-v1 REQ-003). A version 3 approval summary's decisions may carry a `presence` block: the approver's presence signature over the record's own decision fields (`identityAssurance: "presence-signed"`), or the per-person exception that let the decision proceed unsigned (`bypass`). The new migration, `phaseApprovalV2ToV3`, only stamps the version: a version 2 summary's decisions carry no presence block, and every other field is copied unchanged. A version 1 summary reads through both steps.
- New: `phaseApprovalSummaryVersion(decisions)`. A summary is written at version 3 only when one of its decisions carries a presence block, and at version 2 otherwise. A repository that never opted in to SF Guard therefore writes exactly the version 2 summaries it wrote before, which older builds still read; only a Story SF Guard requires writes version 3, which an older build refuses as newer rather than counting its approvals without their signatures.
- The golden fixture carries a frozen version 3 summary with a presence block beside the version 1 and 2 records.

The family reads as `model: never`. Nothing here lets anyone but a person approve: the presence block is written only by the approve and reject commands after the person's own touch, and SF Guard counts a decision only when its signature verifies against the approver's pinned key, or a signed per-person exception covers it.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | `phase-approval` v3 with its migration and the summary version helper. | `sha256:0276ce08aa0558f2a76721e77b8335354226f165529c89a06364be95e61ccbe9` | `sha256:b57907f1650030733319e8502c9a6d37c0e77f81017e4d20619ecefc8b19ed0c` |
