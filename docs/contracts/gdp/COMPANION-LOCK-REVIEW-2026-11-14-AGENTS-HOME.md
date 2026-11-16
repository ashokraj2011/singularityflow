# GDP companion authority review — the agents home — 2026-11-14

Review boundary: `e0815f5237608aa32c36cf327dd5db321ce6a27e` (`main`, at the start of this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-13-TEST-RUN-WORKFLOW.md`.

One GDP-locked companion changes in this review: `smart-initialization-v1` (`src/initialization/proposal.mjs`). SPEC-AGH v1 moves SFlow's step agents from `.github/agents/` to `singularity/agents/` [AGH:REQ-006]. This review records what changed, read from the file. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `src/initialization/proposal.mjs` (`smart-initialization-v1`)

- **The proposed `workflow.yml` records the agents home.** It carries `agentPromptsRoot: singularity/agents` right after `version`, so the configuration a person activates says where its agents live [AGH:REQ-002].
- **The proposed agents are under `singularity/agents/`.** The step-list trim that keeps only the selected workflow's steps in each agent's `sflow-phases` and `sflow-default-for` now matches agent files at that path (the paths come from `SMART_INITIALIZATION_ASSETS`, which moved with them). The rendered bytes of each agent are unchanged.
- **What this does not change:** no detector, preset policy, activation channel, origin map, built-in invariant or suggestion; no approval group, member or sign-off minimum. Activation still refuses a target that already exists; a team's own `.github/agents/` file is simply no longer a target, so it no longer meets that refusal.
- **Checked by:** `test/smart-init.test.mjs`, `test/agents-home.test.mjs` and `test/gdp-contract-freeze.test.mjs`.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `smart-initialization-v1` | The smart-init proposal records `agentPromptsRoot: singularity/agents` and proposes its agents in `singularity/agents/` | `sha256:1701ccd4b2c0bae3543916d594d640402a7d14d504d01867ed631a66cb0da208` | `sha256:ff3f29f86293a6e8bb748914f5b6f4720b76dad70e960da00c2478c55bebb941` |
