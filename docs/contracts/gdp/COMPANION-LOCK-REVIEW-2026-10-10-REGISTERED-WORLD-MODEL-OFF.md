# GDP companion authority review — the registered World Model is off by default — 2026-10-10

Review boundary: `700b6dee1baa113e7483a87f046aa07e51bbc3eb` plus the change reviewed below. The preceding review is `COMPANION-LOCK-REVIEW-2026-10-09-RETIRED-VIEWS-GUIDANCE.md`.

The product owner decided on 2026-10-10 not to use the registered World Model (WMB v4 views published on the state branch and the exact-history packets pinned to Stories): it is switched off rather than run beside a successor. Phase prompts already carry a Repository brief read from the source with no build and no model (World Model v5, M0–M2), so nothing they need comes from the registered model. A new setting, `worldModel.registered: off | on`, is off unless a repository sets it on. The change narrows authority and grants none: while it is off nothing builds, reads, verifies or asks for the registered model, and a Story that pinned it continues without it. Two GDP-locked companions change:

- `templates/workflow.yml` (`workflow-configuration`), accepted at `sha256:59843ffe…`.
- `docs/WORLD-MODEL-BUILDER-V4.md` (`world-model-v4`), accepted at `sha256:4f9c5de1…`.

No other companion changes.

## Reviewed in `templates/workflow.yml`

- `worldModel.registered: off` is added with a comment saying that every phase prompt gets the Repository brief and that the settings after it are kept only for a repository that sets it on.
- The `grounding` comment now says it applies with `registered: on`. No value changes: `format`, `views`, `v4`, `grounding: warn`, `staleness`, `injection` and every phase and agent view assignment are as before, and are ignored while the switch is off.
- No work type, phase, artifact set or MCP server changes, so the packaged workflow value digests (`src/packaged-workflow-history.mjs`) are unchanged.

## Reviewed in `docs/WORLD-MODEL-BUILDER-V4.md`

- A new "Off by default" section lists what happens while the switch is off: Story start selects no history pin and records `WMP_STORY_ACTIVATION_NOT_CONFIGURED`; compose reads no view and receipts are not checked against a model; a Story that pinned `warn` or an active history pin continues without it; registered commands refuse with `WMB_REGISTERED_OFF` while `wm status` and `wm availability` answer `off`; `wm migrate-views` has nothing to rewrite; the gateway plans no build; VS Code offers no build. The remaining settings are accepted, validated and ignored.
- "Enable v4" now starts with setting `worldModel.registered: on`.

## What the change does elsewhere (not companions)

`src/world-model-policy.mjs` adds `registeredWorldModelOn` and `effectiveGroundingMode`; `groundingMode` (`src/grounding.mjs`) returns `off` while the switch is off, and every reader of a Story's grounding (`next`, `nextsteps`, Auto, status summaries, Initiative context) goes through it instead of `resolution.worldModelGrounding`. Compose, prompt reuse and receipt verification ignore a Story's history pin while off; `inspectConfiguredGrounding` answers `off` without reading the state branch, which quiets the editor snapshot, workspace status, the context broker, the evidence packet and Initiative evidence; the Story-start state prefetch is skipped; `wm` registered commands and the gateway build planner refuse; `doctor` stops naming retired v3 view settings that are not used. Pinned Story values are not rewritten. No file under `src/world-model/` changes, so the WMB kernel identity is unchanged.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `workflow-configuration` | `worldModel.registered: off` with its comment; the grounding comment says it applies with `registered: on`. | `sha256:eb170ff17215ea049266391640b40fdb7b90126fc496eb5757dfc57f01f07e2e` | `sha256:59843ffe6498d4d1b7a7f14459e45b163878c2c9baba36d0114e01e59f122529` |
| `world-model-v4` | "Off by default" section; "Enable v4" starts with `registered: on`. | `sha256:c3b16850f3ca8db49f0380f781defb99e4e2a444b7468d3b1dc90044b5a24088` | `sha256:4f9c5de12a94f5aee87a11e3683c97b721257c3e2e59709382e9d422f9966b71` |
