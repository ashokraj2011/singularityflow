# GDP companion authority review — the World Model is guidance — 2026-10-09

Review boundary: `376692f2a634a44cd1cabba79c9bd740347ac330` plus the guidance-only World Model change reviewed below. The preceding review is `COMPANION-LOCK-REVIEW-2026-10-09-LOCAL-EVIDENCE-REVIEW.md`.

The product owner decided on 2026-10-09 that the World Model is guidance and must never become authority. The change removes every place where a missing, stale, invalid or unprovable World Model could refuse, gate or authorize a lifecycle action. It narrows authority; it grants none. Two GDP-locked companions change, both in wording only:

- `templates/workflow.yml` (`workflow-configuration`), accepted at `sha256:3d2b465a…`.
- `docs/WORLD-MODEL-BUILDER-V4.md` (`world-model-v4`), accepted at `sha256:8daa24d5…`.

No other companion changes.

## Reviewed in `templates/workflow.yml`

Comments only; the parsed configuration value is identical (its packaged value digest is unchanged).

- The `worldModel.grounding` comment no longer says `enforce` "fails closed". It says the World Model is guidance: a repository without a model, without a provider, or with a stale or unverifiable model runs its whole lifecycle; `warn` reports such context and leaves it out with a stable unavailable receipt; `enforce` and staleness `fail` are still accepted and act as `warn`.
- The `architectureIntent` comment says the intent is checked against the CALM projection at the listed phases and reported as warnings, never blocking. The `blockRequiredUnfulfilledAt` key and its default list are unchanged.

## Reviewed in `docs/WORLD-MODEL-BUILDER-V4.md`

- Story creation records a typed unavailable exact-history pin with the failure code whenever a cut cannot be selected, so Story creation never fails because of World-Model history.
- Pin rewind, authority or repository-identity drift, missing or tampered bytes and closure mismatch leave the pinned packet out of the prompt with a warning, recorded in the receipt; a pending prompt whose pin cannot be re-proved is recomposed. The resolver still never falls back to the mutable current projection.
- Grounding: the World Model is guidance; bytes that fail verification are left out and reported; `enforce` is accepted and acts as `warn`.

## What the change does elsewhere (not companions)

Grounding verification reports every finding as a warning; publish, Story completion, Auto, `next`, planning, capability and Initiative context no longer refuse on grounding; staleness `fail` and `intelligence.worldModel: required` act as `warn`; the architecture-intent gate reports instead of refusing; the prompt budget may drop the pinned World-Model section, which is then recorded as unavailable; `doctor` names the settings that no longer block; the VS Code Configuration Center offers Off/Warn and Warn/Ignore. The kernel's Story-activation change has its own WMB registry-lock review ("Story grounding activation is guidance").

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `workflow-configuration` | Grounding and architecture-intent comments describe the World Model as guidance; configuration values unchanged. | `sha256:3d2b465ac4bc6c8aa116cc3d9ad50ab90580fc8350c2a9072de414ddeb6d6e58` | `sha256:eb170ff17215ea049266391640b40fdb7b90126fc496eb5757dfc57f01f07e2e` |
| `world-model-v4` | Story creation never fails on history; pinned-history failures leave the packet out or recompose; grounding never blocks and `enforce` acts as `warn`. | `sha256:8daa24d5d0c86fa0cce8e200466aaacd8a8d4bb931774ec374385a325d9395c6` | `sha256:8a39ff76e3fa891a3c0a689f6669b3093e4fdb474c63126da4660c2137126a2c` |
