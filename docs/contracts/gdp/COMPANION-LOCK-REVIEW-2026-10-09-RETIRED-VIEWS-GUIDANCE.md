# GDP companion authority review — retired legacy-v3 views are guidance too — 2026-10-09

Review boundary: `b931b39689a80a23251410b62dbdaa44b2eb1f9a` plus the retired-view change reviewed below. The preceding review is `COMPANION-LOCK-REVIEW-2026-10-09-WORLD-MODEL-GUIDANCE.md`.

The product owner decided on 2026-10-09 that a repository whose governed configuration still names the retired legacy-v3 World Model (its format, its seven view names, or `v4.legacyAssignments: inherit-configured`) is warned and offered a migration command instead of refused. It follows the earlier decision that the World Model is guidance and never authority: such a configuration had refused every command that loads it, including AST intelligence, while phases already ran without World Model context. The change narrows authority; it grants none. One GDP-locked companion changes, in wording only:

- `docs/WORLD-MODEL-BUILDER-V4.md` (`world-model-v4`), accepted at `sha256:8a39ff76…`.

No other companion changes.

## Reviewed in `docs/WORLD-MODEL-BUILDER-V4.md`

- The legacy-v3 paragraph says its commands and options are still refused with `WMB_FORMAT_RETIRED`, while a configuration that still names its format, views or assignment bridge loads with those entries dropped: a phase or agent assigned only v3 views runs without World Model context and `doctor` names each dropped entry.
- It documents `sflow wm migrate-views`: a preview, then an exact `--confirm` phrase, rewriting `workflow.yml`, `portfolio.yml` and Agent Markdown to registered views with the packaged mapping (`business` to `biz.rules`, `architecture` and `security` to `arch.contracts`, `development` and `testing` to `dev.impact`; `release` and `operations` removed), keeping each file's formatting, published like any configuration edit. A new phase is never written with a v3 view.
- The `WMB_FORMAT_RETIRED` recovery entry lists what still refuses (commands, options, a new phase, a Story pin) and points a configuration at the migration command.

## What the change does elsewhere (not companions)

Workflow, agent, workflow-override, injection-rule and Initiative assignments drop retired names when they load (`src/world-model-views.mjs` `dropRetiredWorldModelReferences`, Initiative normalization and pinned-phase composition); onboarding, agent-catalog validation and capability sibling reads no longer refuse them; `doctor` reports a `world-model-views` warning; `wm migrate-views` (`src/world-model-view-migration.mjs`) writes only working-tree configuration and restores every file if the result does not load. No kernel file, packaged configuration value, approval authority, publication rule or Story pin changes.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `world-model-v4` | A configuration naming retired v3 views loads with them dropped and `doctor` naming them; `wm migrate-views` rewrites them; commands, options, new phases and Story pins still refuse. | `sha256:8a39ff76e3fa891a3c0a689f6669b3093e4fdb474c63126da4660c2137126a2c` | `sha256:c3b16850f3ca8db49f0380f781defb99e4e2a444b7468d3b1dc90044b5a24088` |
