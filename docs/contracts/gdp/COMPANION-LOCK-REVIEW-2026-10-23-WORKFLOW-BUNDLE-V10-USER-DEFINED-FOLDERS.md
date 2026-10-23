# GDP companion authority review — workflow bundle v10 (user-defined agent folders) — 2026-10-23

Review boundary: `e3b13fe21662c20c828ea306cc44d4dd923b8ed3` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-23-SAMPLE-USER-DEFINED-AGENT.md`.

One GDP-locked companion changed: `migration-registry` (`src/schema-migrations.mjs`). No other locked companion drifted at the boundary. This is a bounded review of one record family's version step. It is not a bulk hash refresh, and it adds no approval authority.

## Reviewed in `src/schema-migrations.mjs`

- The `workflow-bundle` family moves from `currentVersion: 9` to `10` and gains `migration(9, 10)`, an identity step that changes only `schemaVersion`. A v9 bundle therefore reads exactly as before, and a migrated v9 bundle carries no user-defined folder.
- The comment records what v10 means for the bundle contract, which `src/workflow-transfer.mjs` enforces:
  - A v10 bundle may carry asset kind `user-defined`: for each carried agent that `call add` made, its manifest `singularity/user-defined/<name>.json` and every file that manifest lists under `singularity/user-defined/<name>/`, byte for byte, owned by that agent (`owner: { kind: agent, id }`).
  - Export reads the folder from the source configuration and requires the manifest to match the digest the agent pins and every file to match its manifest entry. A folder edited by hand is refused (`WORKFLOW_USER_AGENT_FOLDER_CHANGED`) rather than carried, because the destination could not compose the step from it.
  - The reader requires every carried user-defined agent to bring its folder: the pinned manifest, every listed file by hash, and nothing else. A missing or changed file is refused (`WORKFLOW_BUNDLE_USER_AGENT_FOLDER_MISSING`), and a user-defined file no manifest lists is refused (`WORKFLOW_BUNDLE_DEPENDENCY_EXTRA`).
  - A v9 or older bundle carries no folder. If it brings a user-defined agent, the reader refuses it with `WORKFLOW_BUNDLE_USER_AGENT_FOLDER_MISSING` and says to export again. The import preview therefore names the problem instead of saying the bundle is ready. Before this change such an import was accepted, and the destination's Story start then failed with `USER_AGENT_FOLDER_CHANGED` ("has no manifest"). An older bundle without a user-defined agent reads as before.
- Also in `src/workflow-transfer.mjs` and `src/workflow-transfer-resolution.mjs`, outside the companion:
  - Imported folder files belong to their agent's conflict subject (`agent:<id>`).
    - A byte-identical file is reused ("already here").
    - A different one is a conflict of the agent, kept or replaced with it.
    - Rename is refused for such an agent, because its metadata names its folder and pins the manifest.
  - Folder files keep their exact bytes. Line endings are never normalised, as with vendored copies.
- Who approves an import is unchanged. Import still previews an exact plan, binds the person's choices in `planSha256`, and writes through the same configuration proposal or local route. Activation remains a separate, explicit human step.
- Existing Stories are unaffected. Bundles are transfer records outside any Story snapshot.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | `workflow-bundle` v9 → v10 identity migration and its contract comment. | `sha256:3e5a95c3416eff77bf5643d9a652664ef8c416540e50ed6c24514294787b5440` | `sha256:31054ef20836147789698b24a358421fd7de45f26fb64e887395021476741477` |
