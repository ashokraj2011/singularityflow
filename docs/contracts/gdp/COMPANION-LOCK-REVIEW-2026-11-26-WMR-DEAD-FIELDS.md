# GDP companion authority review — World Model text in the packaged workflow (WMR M1, dead fields) — 2026-11-26

Review boundary: `0aaac1bb444ee2a0aede7dfd900f4e936d443566` (`main`, the base of `wm-dead`). The preceding review is `COMPANION-LOCK-REVIEW-2026-11-26-SSB-M1.md`.

One GDP-locked companion differs from its accepted bytes: `workflow-configuration` (`templates/workflow.yml`). WMR M1 (docs/SPEC-WMR-WORLD-MODEL-REPAIR-v1.md) retires what is left of the removed registered World Model. This review reads the file as `wm-dead` leaves it. Every other companion still matches its accepted digest.

## Reviewed in `templates/workflow.yml` (`workflow-configuration`)

- **Comments only, in three places.** The context-policy comment says a new conversation rebuilds its prompt from the Repository brief, not from "world-model views". The `worldModel` comment says what WMR REQ-011 built: a design, plan or code step gets the brief; intake, requirements, verification and release get none by default; `intelligence.worldModel: on` gives it to every step, and `knowledge.prompt` may name steps. The spec-driven comment names the Repository brief instead of "world-model".
- **Two descriptions.** `benchmarking-a` measures "the Repository brief" instead of a "governed world-model"; `benchmarking-b` runs "without the Repository brief" instead of "without world-model". Each work type's earlier digest is recorded as a known earlier version (`src/packaged-workflow-history.mjs`), so a refresh replaces an unedited copy; the current digests move.
- **What this does not change:** no key, phase, work type, step, input, approval group, member, minimum, rule, intelligence setting or `worldModel` value changes. `worldModel.knowledge.prompt` stays `slice`.
- **Checked by:** `test/gdp-contract-freeze.test.mjs`, `test/packaged-provenance-registry.test.mjs`, `test/registered-world-model-removed.test.mjs`, `test/plugin.test.mjs` (shipped text names no removed World Model feature).

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `workflow-configuration` | World Model comments and two benchmark descriptions name the Repository brief | `sha256:40d23c40284d77f4a5ef2923479d9946617bae1b149034181af665417b7e7387` | `sha256:7f472d26a9be36ac12922c87a3b4fa034b525bdf8bfc63a98b324c874382513d` |
