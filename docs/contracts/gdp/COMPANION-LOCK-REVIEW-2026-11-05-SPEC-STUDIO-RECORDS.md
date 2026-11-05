# GDP companion authority review — Spec Studio shared drafts and draft index — 2026-11-05

Review boundary: `94aae60193b4c96d6f62717aedc9d57b4d912c0f` (the Spec Studio branch with `main` merged, at the start of this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-05-COMMIT-POLICY-AND-TASK-RECORDS.md`.

One GDP-locked companion differs from its accepted bytes: `migration-registry`, changed by `2159bbbd4`, Spec Studio's write-together editing and shared drafts. This records what changed and why, from the diff of the file against its accepted bytes. No other locked companion differs at this boundary. This review does not change the file.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

Five families were added at `currentVersion: 1` with no migration step, and two existing families moved to version 2 by an identity step. No path pattern of an existing family and no immutability flag changed.

- **`spec-draft` and `spec-manifest`, version 1 to 2:** `migration(1, 2, identity(2))`. Version 2 adds optional fields: a draft's kind, sources and origins, and the same on a manifest. A record without them stays readable as unclassified, so no stored record is reinterpreted. Snapshot and manifest readers verify the original bytes, so an existing digest or signature is not recomputed.
- **`spec-draft-index`, mutable, under `$git`:** a rebuildable index of one draft's snapshots. A missing, torn or newer index falls back to the immutable snapshots.
- **`spec-shared-draft`, immutable, on the state branch:** one unreviewed checkpoint, bound to its own digest. It never appears as a reviewed revision.
- **`spec-shared-head`, mutable, on the state branch:** the pointer to the current checkpoint, updated with an exact expected value.
- **`spec-shared-basis` and `spec-sync-schedule`, mutable, under `$git`:** this laptop's acknowledgement of what it shared and its automatic sharing schedule. Neither advances document history or approval state.

Registering a family grants nothing: it says how stored bytes are read. A checkpoint cannot satisfy a reviewed-revision or signature requirement, and what may be published stays with the sharing check and the person's own steps.

- **Checked by:** `test/mig-golden.test.mjs`, which reads a frozen record of every registered family to its current version, `scripts/check.mjs`, which requires every family to have goldens, `test/spec-studio-write-together.test.mjs` for a version 1 draft keeping its digest and a newer checkpoint being refused for that entry alone, and `test/spec-studio-draft-index.test.mjs` for the index falling back.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | Five new families for shared drafts and the draft index; `spec-draft` and `spec-manifest` to version 2 by an identity step. | `sha256:333fa1b274189858f19bd4e0d549b6015ca035da0d0a9cdb5798aa2628188d3a` | `sha256:a49a0c148ef95606ac503c11728c5e4117c92a6b0f5cd3c140e9dabd7d9d77fc` |
