# GDP companion authority review — the name on a "still holds" answer — 2026-11-09

Review boundary: `09b814e44c31f345c1e52b277701b109547fcd59` (`scs-m2c` before this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-08-FINDINGS-REMEDIATION.md`.

One GDP-locked companion changes: `migration-registry`. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

- **What changed:** one new family, `amendment-revalidation`, at version 2, with one identity step from version 1. No other family changes.
- **The record:** a step's own approvers' answer after an amendment ("still holds" or "return"), one entry in a Story's `amendmentRevalidations` list in `workflow.json` (SCS:REQ-022). It is embedded, so the family has no stored path, like `skill-version-adoption-summary`.
- **Version 2** keeps the person's name (`actorName`) beside the existing actor key, so "still holds" is shown by name, not by Git email, on the decide card, the approval page, the Copilot CLI table, the terminal approval preview, the stored approval's carried section and the evidence matrix.
- **Version 1** is every answer written before: it has no `schemaVersion` (`unversionedAs: 1`) and no name. It reads as is, and its label falls back to the actor key. The step infers no name.
- **What this does not change:** which answer counts. An answer still counts only when it is `unchanged`, binds the amended scope generation, and was recorded under one of the step's own approval groups. The name is display only; the actor key stays the identity. `story-workflow` stays at v13: a v13 build that ignores the name shows the key, which is the same fallback.
- **Checked by:** `test/scope-revisions.test.mjs` (a v2 answer is named, a v1 answer falls back to its key and reads with no invented name), `test/scs-conformance-differences-flow.test.mjs` (fixture A records v2 answers with the name, and the label, the terminal preview and the stored approval show it), and the goldens in `test/fixtures/schema-migrations/goldens.json` (frozen v1 and v2).

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | New embedded family `amendment-revalidation` v2 (identity step from v1): a "still holds" answer keeps the person's name beside the actor key | `sha256:b05ce6eff1dacf209ca6226919b4d8d488faf7870c07a203117834b60308647f` | `sha256:ae0ec74f0c97e0fc450ddf0be5699f946af25c57458a89eba731d92fed8ce33f` |
