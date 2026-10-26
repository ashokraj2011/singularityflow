# GDP companion authority review — workflow bundle v11 (agent folder office documents, images and PDFs) — 2026-10-26

Review boundary: `48d03fc8a3ebad13b3e1cf381e007ac5d35790f2` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-26-TERMINAL-REVIEW-OUTPUT-AND-STORY-INDEX.md`.

One GDP-locked companion changed: `migration-registry` (`src/schema-migrations.mjs`). No other locked companion drifted at the boundary. This is a bounded review of one record family's version step. It is not a bulk hash refresh, and it adds no approval authority.

## Reviewed in `src/schema-migrations.mjs`

- The `workflow-bundle` family moves from `currentVersion: 10` to `11` and gains `migration(10, 11)`, an identity step that changes only `schemaVersion`. A v10 bundle therefore reads exactly as before, and a migrated v10 bundle carries only text files.
- The comment records what v11 means for the bundle contract, which `src/workflow-transfer.mjs` enforces:
  - `call add` now keeps a folder's Word, Excel and PowerPoint files, images and PDFs byte for byte, and its manifest records each one's kind (`document` or `viewable`). A v11 bundle carries such a file as a `user-defined` asset with `encoding: base64`: canonical base64 of the exact bytes, its `size` and `sha256` those of the decoded bytes, so they match the manifest entry the destination checks.
  - Only a `user-defined` asset may carry `encoding`, only `base64`, and only in a v11 bundle. A v10 or older bundle that carries one is refused (`WORKFLOW_BUNDLE_ASSET_INVALID`). A non-canonical encoding is refused too.
  - Each encoded file is at most 4 MiB, the per-file bound `call add` applies. The bundle's aggregate asset bound counts the encoded text, so the bundle file stays within its 20 MiB limit.
  - Export encodes only the files the manifest marks as a document or viewable. Any other file must still be UTF-8 text, or the export is refused as before (`WORKFLOW_USER_AGENT_FOLDER_CHANGED`).
- Who approves an import is unchanged. Import still previews an exact plan, binds the person's choices in `planSha256`, and writes through the same configuration proposal or local route. Activation remains a separate, explicit human step.
- Existing Stories are unaffected. Bundles are transfer records outside any Story snapshot.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | `workflow-bundle` v10 → v11 identity migration and its contract comment. | `sha256:bb157e513ae0d77fbb2b0e8a9a1e79fd3a3b3eb93de4350f25a3f514ab8969b0` | `sha256:28386f08262252a675692db049015e2be323151a7b3306225514f437144c3709` |
