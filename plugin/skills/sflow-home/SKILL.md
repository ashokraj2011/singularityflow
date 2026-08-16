---
name: sflow-home
description: Open the Singularity Flow home for the current workspace, then explicitly route the contributor's selected goal into the matching guided flow.
disable-model-invocation: true

---
# Singularity Flow cockpit

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Show current state, collect one explicit menu selection, and follow only the selected guided flow. Never infer or preselect a goal.

1. Run `singularity-flow home --json`. Preserve its outcome, reasons, warnings, current work, counts, and ordered `next` actions.
2. Render every returned action label with its detail and `fallback.skill`. Use Copilot's `ask_user` facility to ask the contributor to select exactly one. Do not treat free-form text as an action ID and do not preselect the primary action.
3. Route the selected action by reading and following the sibling packaged skill below. A Copilot session cannot invoke another slash command inside itself, so follow that skill's instructions directly rather than merely printing its name:
   - `home:work.continue` → `../sflow-resume/SKILL.md`, preserving the returned `slots.work` as its Work ID.
   - `home:work.list` → `../sflow-session/SKILL.md`.
   - `home:work.return` → `../sflow-work-interval/SKILL.md`, using `reconcile` and the returned Work ID when present.
   - `home:work.start.intake` → `../sflow-start/SKILL.md`. Ask for the Work ID required by that skill before following it.
   - `home:workspace.switch` → `../sflow-workspace/SKILL.md`.
   - `home:impact.quick` → `../sflow-workspace-impact/SKILL.md`.
   - `home:repository.explore` → `../sflow-inspect/SKILL.md`.
   - `home:help.explain` → `../sflow-help/SKILL.md`.
4. If the selected action is not in this map, stop and reproduce its `fallback.skill` and `fallback.command`; do not guess a destination.
5. After a selected flow completes, run `singularity-flow home` once and reproduce the refreshed home. This makes a newly started, resumed, or switched work item visible without requiring the contributor to remember another command.
6. The initial home read must not mutate lifecycle state. Only the explicitly selected sibling flow may do so. If setup is incomplete, run `singularity-flow doctor` and explain only its failed or warning checks.
