# GDP companion authority review — legacy-v3 World Model removal — 2026-10-09

Review boundary: `d206b553b742bb73b549cdee5add2870e0c7f0a5` plus the legacy-v3 removal patch reviewed below. The preceding review is `COMPANION-LOCK-REVIEW-2026-10-09-HOOK-PUBLICATION-AND-RECORD-FAMILIES.md`. The patch was prepared on `94ed35919ef19805c50b2973260a0ba7e04ea08a`; the three commits between that and the boundary (`99c12409`, `80f7d89c`, `d206b553`) touch neither companion below, so the digests here hold at the boundary.

Two GDP-locked companions change in this patch: `workflow-configuration` (`templates/workflow.yml`) and `world-model-v4` (`docs/WORLD-MODEL-BUILDER-V4.md`). `main` already carried unreviewed changes to both, so the lock failed on `main`:

- `templates/workflow.yml` was accepted at `sha256:dd5b1831…` (the `fb036910` bytes). `7b64eace`, `c664e5e8`, `03ae601e` and `048da957` changed it without a companion review; at the boundary its digest is `sha256:2650590e8e52a6f4cb82cb0f2bd5abc53d388a9716c22d713bce576f769d0f45`.
- `docs/WORLD-MODEL-BUILDER-V4.md` was accepted at `sha256:fb19e895…`. `048da957` and `8045016b` changed it; at the boundary its digest is `sha256:2fa69dafe65568303b05361f256ef28d451a9e09fa3ff95b07a620eaa83506b5`.

This review covers those changes after the fact, with the removal on top. It is not a bulk hash refresh or a new approval authority. Three other companions (`publication-unit-of-work`, `action-authorization`, `migration-registry`) also drifted on `main`. The preceding review accepted `publication-unit-of-work` and `migration-registry`; `action-authorization` remains unaccepted. This patch touches none of them and this review accepts none of them.

## Reviewed after the fact in `templates/workflow.yml`

- `7b64eace` adds the `document-test-repair` work type ("Document-led acceptance & repair") with phases `document-intake`, `scenario-check`, `scenario-repair` and `scenario-retest`.
  - Planned claims are required, owned by `document-intake`. Documents are offered only to `document-intake`.
  - Two branch decisions (`existing-behavior` after `scenario-check`, `repaired-behavior` after `scenario-retest`) route on an agent verdict of pass, repair or blocked. Each allows at most two rounds. The pass route out of `scenario-check` omits `implement`, with `quality-reviewers` as its authority and a stated reason.
  - Phase approvals use the existing authorities (`product-approvers`, `quality-reviewers`, `engineering-reviewers`; minimum 1). Each new phase uses `worldModel: { views: [], depth: quick }`.
  - The `playwright` MCP server adds the `scenario-tester` agent and the `scenario-check`/`scenario-retest` phases. Approval stays `confirm`, `required: false`.
- `c664e5e8` adds `demo-web-e2e-testing` ("Demo Web E2E Testing") with phases `demo-web-intake`, `demo-web-check`, `demo-web-repair` and `demo-web-retest`.
  - The structure is the same as above: required planned claims, documents at intake only, and two verdict decisions of at most two rounds each, with a `quality-reviewers` omission of `implement` on the pass route.
  - `playwright` adds the `demo-web-tester` agent and the `demo-web-check`/`demo-web-retest` phases.
- `03ae601e` adds `demo-check-repair-close` ("Demo — Check, Repair & Close") with phases `demo-intake`, `demo-check`, `demo-repair` and `demo-close`.
  - The work type omits `implement` at its natural endpoint, with `quality-reviewers` as authority and a stated reason.
  - Two decisions of at most three rounds each: `demo-check-result` (pass to `demo-close`, repair, or recheck) and `demo-repair-handoff` (recheck or revise intake).
  - A new `demo-playwright` MCP scope reuses the Playwright host for `demo-code-checker` in `demo-check` only, with approval `confirm` and `required: false`.
- `048da957` makes the packaged configuration native registered-v4.
  - It sets `worldModel.format: registered-v4`, the catalog `[arch.contracts@4, biz.rules@4, dev.hotspots@4, dev.impact@4]`, and `v4` composer `deterministic`, consumer `developer`, cache `reuse-valid`, `legacyAssignments: strict`. `promptSource` becomes `builtin`.
  - It rewrites the 28 phase `worldModel.views` assignments from v3 names to registered IDs: `business` → `biz.rules`, `architecture`/`security` → `arch.contracts`, `development`/`testing` → `dev.impact`. Depths and `evidence` flags are unchanged.
- None of these commits changes an existing work type, approval authority or minimum, publication rule, or Story pin. They add packaged choices, and their own phases carry their approvals.

## Reviewed after the fact in `docs/WORLD-MODEL-BUILDER-V4.md`

- `048da957` describes registered-v4 as the default for new repositories and packaged workflows, and documents the transition bridge (`inherit-configured`). This patch removes that bridge.
- `8045016b` documents the one local layout repair of model composition citations. The repair needs exact canonical prose for cited admitted facts and reruns the complete validator. It never repairs invented claims, unknown identities, missing obligations, assurance, scope or integrity, and it is recorded as a content-free activity event. No authority changes.

## This patch

`templates/workflow.yml`, inside `worldModel` only (every other node is byte-identical to the boundary):

- **Removed:** `v4.legacyAssignments: strict`, `promptSource: builtin`, and `generation.strategy`, `maximumDiscoveryPacketBytes`, `maximumSynthesisInputTokens` and `synthesisOverflow`, all settings of the removed legacy-v3 builder.
- **Kept:** `generation.parallel` and `maxWorkers`.
- **Comments only:** comments that described the dormant v3 builder, the assignment bridge and rule-based injection are rewritten.

The engine still accepts the removed keys (ignored) in existing repositories, so no repository is refused for carrying the old packaged bytes.

`docs/WORLD-MODEL-BUILDER-V4.md`:

- **States the cutover:** registered-v4 is the only format, and an omitted `format` uses it.
- **States the refusal:** `format: legacy-v3`, v3 view names and `inherit-configured` are refused with `WMB_FORMAT_RETIRED`.
- **States Story behaviour:** a Story started under legacy-v3 keeps its records and composes with zero World Model bytes.
- **Removes:** the transition-bridge instructions, the `--format v4` one-command override in compatibility repositories, and the legacy Build / refresh path in VS Code.
- **Adds:** a `WMB_FORMAT_RETIRED` troubleshooting entry.

The patch grants no approval, import, overwrite or publication authority and removes one: the automatic assignment bridge and its `--migrate-world-model` configuration migration. Hashed Story pins are not rewritten. A pin that does not select registered-v4 is read as the retired format: every World Model entry point refuses it by name, and its lifecycle continues without World Model context.

## Reviewed drift

| Companion | Authority change reviewed | Previous digest | Accepted digest |
| --- | --- | --- | --- |
| `workflow-configuration` | Three added work types with their phases, decisions, omissions and MCP scopes (`7b64eace`, `c664e5e8`, `03ae601e`); native registered-v4 packaged configuration (`048da957`); removal of the retired legacy-v3 builder settings, as above. | `sha256:dd5b183194d047e60a02268e66d6e75640ca88bf1a1b661711056647dd983794` | `sha256:3d2b465ac4bc6c8aa116cc3d9ad50ab90580fc8350c2a9072de414ddeb6d6e58` |
| `world-model-v4` | Registered-v4 default and model-citation layout repair (`048da957`, `8045016b`); legacy-v3 removal and `WMB_FORMAT_RETIRED`, as above. | `sha256:fb19e89523dddf37fa11dcf8b13305d6c128de0deefeea7b3e4ce2df5f710098` | `sha256:8daa24d5d0c86fa0cce8e200466aaacd8a8d4bb931774ec374385a325d9395c6` |

## Validation evidence

- **Configuration:** the configuration validation and World Model defaults tests (an omitted format becomes registered-v4; legacy-v3, v3 view names and `inherit-configured` are refused with `WMB_FORMAT_RETIRED`).
- **Lifecycle:** packaged workflow provenance and phase publication readiness tests, plus the Story intake start and workflow tests.
- **World Model:** the registered World Model command, runtime, publication and grounding suites, including the `prompt-injection` receipt verification of unavailable and registered receipts.
- **Lock:** the GDP contract-freeze test, for these two companions.

## Sanctioned reconciliation procedure

1. Run the GDP companion-lock test and confirm `workflow-configuration` and `world-model-v4` are the only companions this patch changes.
2. Confirm every non-`worldModel` node of `templates/workflow.yml` is byte-identical to the boundary.
3. Run the configuration, World Model defaults, packaged workflow provenance, phase publication readiness, Story intake, workflow, World Model and GDP contract-freeze tests.
4. Accept only the reviewed digests above, and leave `baselineCommit` unchanged.
5. Require another bounded companion review for any later byte change to these companions.
