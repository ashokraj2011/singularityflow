# GDP companion authority review — the registered World Model is removed — 2026-10-10

Review boundary: `71ba48472fffc2860235e229798f55cb961f2e25` plus the change reviewed below. The preceding review is `COMPANION-LOCK-REVIEW-2026-10-10-REGISTERED-WORLD-MODEL-OFF.md`.

After switching the registered World Model off, the product owner decided on 2026-10-10 to delete it entirely, together with the CALM architecture projection and Story architecture intent. Phase prompts keep the Repository brief read from the source with no build and no model; nothing they need came from the registered model. The change removes authority and grants none. One GDP-locked companion changes and one is retired:

- `templates/workflow.yml` (`workflow-configuration`), accepted at `sha256:dae5059f…`.
- `docs/WORLD-MODEL-BUILDER-V4.md` (`world-model-v4`) is deleted with the builder it described, so its companion entry is removed from the lock. Its last accepted digest was `sha256:4f9c5de12a94f5aee87a11e3683c97b721257c3e2e59709382e9d422f9966b71`.

No other companion changes.

## Reviewed in `templates/workflow.yml`

- The `worldModel` block now holds only `knowledge.prompt: slice` and the commented `sourceRoots` / `sharedRoots` examples, with a comment saying every phase prompt gets the Repository brief, how to see it (`singularity-flow wm brief --phase PHASE`) and how to leave it out (`intelligence.worldModel: off` for a work type, `knowledge.prompt: off` everywhere). `knowledge.prompt: slice` is the default, so the brief a phase receives is unchanged.
- Removed: `registered`, `format`, `views`, `v4`, `projections` (CALM), `outputDir`, `historyDir`, `stateFetchTimeoutMs`, `generation`, `materialization`, `grounding`, `staleness` and `injection`; the top-level `architectureIntent` block; and every phase-level and phase-override `worldModel: { views, depth, evidence }` assignment (44 phases and the `benchmarking-b` overrides).
- A repository that still writes any of these keys keeps loading: they are dropped at load and `doctor` names them once (`removed-settings`).
- Work-type `intelligence.worldModel` stays; it now turns the Repository brief on or off.

Because 44 packaged phases and the `benchmarking-b` work type change, their previous values are registered as historical framework provenance (`src/packaged-workflow-history.mjs`), so a repository seeded from the earlier template is still recognised as framework-owned and upgrades. The same is done for the 14 packaged agents that lose their `sflow-world-model-views` header (`src/packaged-asset-history.mjs`).

## What the change does elsewhere (not companions)

The engine under `src/world-model/` is deleted except `view-contract-schema-version.mjs`, which the `migration-registry` companion (`src/schema-migrations.mjs`, unchanged) still imports for the frozen `world-model-view-contract` family. Immutable records keep their fields: publication `architectureIntent` / `architectureDecision` are written as null, prompt receipts record grounding as unavailable, and old Story `resolution.worldModel*` values are ignored, never rewritten. Removed commands refuse by name (`WMB_REMOVED`, `COMMAND_REMOVED`) with a pointer to the brief. Old World Model files on state branches stay in Git, unread.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `workflow-configuration` | The registered World Model, CALM projection and architecture intent settings and every phase view assignment are removed; `worldModel` keeps `knowledge.prompt: slice` and the source-scope examples. | `sha256:59843ffe6498d4d1b7a7f14459e45b163878c2c9baba36d0114e01e59f122529` | `sha256:dae5059f63781e9ed25b159cc6c2f8d6ae7202d83ceeaddd15eab423c8ce6216` |
