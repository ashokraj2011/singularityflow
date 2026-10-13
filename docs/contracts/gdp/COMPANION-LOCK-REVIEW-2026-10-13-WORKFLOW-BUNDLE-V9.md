# GDP companion authority review — workflow bundle v9 — 2026-10-13

Review boundary: `089197d6f191597e1f4a40fb6f114645dd707d19` (`main` at the start of this change). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-12-BROADER-RETURN-ROUTES.md`.

One GDP-locked companion changed: `migration-registry` (`src/schema-migrations.mjs`). No other locked companion drifted at the boundary. This is a bounded review of one record family's version step. It is not a bulk hash refresh, and it adds no approval authority.

## Reviewed in `src/schema-migrations.mjs`

- The `workflow-bundle` family moves from `currentVersion: 8` to `9` and gains `migration(8, 9)`, an identity step that changes only `schemaVersion`. A v8 bundle therefore reads exactly as before. A migrated v8 bundle carries no constitution asset, and the reader still applies the closure rule of the version it was written with.
- The comment records what v9 means for the bundle contract, which `src/workflow-transfer.mjs` enforces:
  - A v9 bundle may carry asset kind `constitution`: the file named by a carried Story workflow's `constitution.path` when its mode is not `off`. The reader refuses a constitution that no carried workflow names (`WORKFLOW_BUNDLE_DEPENDENCY_EXTRA`) and one that does not parse, including the shipped `example: true` sample.
  - A v9 closure keeps an after-step action's integration target whatever it sends. `send` defaults to `event` and Workflow Studio leaves the default out, so the v8 rule (which required `send`) dropped the target, and the destination refused the action with `STEP_ACTION_TARGET_UNKNOWN`. Older bundles keep the v8 rule, so none that read before becomes unreadable.
  - Carried agents are scoped to the exported steps. An agent's `sflow-phases` and `sflow-default-for` lists, and the steps column of its attached-skill rows, keep only the bundle's steps, and a row limited to other steps is dropped. Before this change, an agent that also drafted a step of an unexported workflow made the destination refuse the import with `AGENT_PHASE_UNKNOWN`. Import compares the destination's same agent scoped the same way, so an identical agent is reused and nothing in the destination is rewritten. An imported agent's record notes the transform as `phase-scoped`, beside the existing `materialized-skill-attachments`.
- Also in `src/workflow-transfer.mjs`, outside the companion: a loop decision's `by` groups join the closure as candidates, like a routed decision's. A skill attached to a seeded agent in the source arrives as an `attachments.yml` entry for the destination's own seeded agent; the seeded agent file is never rewritten, and any other difference is still a conflict.
- Who approves an import is unchanged. Import still previews an exact plan, binds the person's choices in `planSha256`, and writes through the same configuration proposal or local route. Activation remains a separate, explicit human step.
- Existing Stories are unaffected. Bundles are transfer records outside any Story snapshot.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | `workflow-bundle` v8 → v9 identity migration and its contract comment. | `sha256:418bf1c7a738d6edb7d7f22db76b0b220b30c49f21122f88b29b25b99422b42f` | `sha256:2831e1cec66227b350858e6efb3269f1fd7e18b3c4f4fe94390bc26059fe47cf` |
