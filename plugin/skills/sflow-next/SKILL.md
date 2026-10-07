---
name: sflow-next
description: Execute one valid Singularity Flow lifecycle action without chaining later actions.
disable-model-invocation: true

---
# Execute the next workflow action

<!-- sflow-copilot-pause -->
First run `singularity-flow nextsteps --for-agent --json` once. It checks pause before Git or Story discovery and returns the verified binding and actions. If `paused`, use native Copilot; explicit SFlow requests only offer `/sf-pause off`; never resume implicitly. Use `personalization.replyName` literally once per reply/suggestion group, never in artifacts or approval identity.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** reuse this invocation's entry: require `ready`/`workId`, valid `phaseAgent` for active phases; cwd=`repositoryPath`. Use returned `workItemRoot`/artifact paths; never `$HOME`.

1. Use the returned binding, active phase, and first `NOW` action; refuse `ACTIVE_SUBJECT_MISMATCH`. No separate pause/session/status calls. Never derive `--task` or silently select another Story. `preparation` delegates composition to the entry-capable authoring skill; it does not waive grounding or permit a rebuild.
2. Never run `singularity-flow next`. Load one returned SFlow skill route (any `/sf-*` or `/sflow-*` route), use its configured producer/channel, complete its preflight, execute at most its one authorized action, and stop. Before approval run `singularity-flow phase show <phase> --json`; validate authority, report the automatic phase agent, and require the exact phase name. Every recorded approval must produce its own commit and push.
3. Sole no-skill exception: when snapshot `state=publication_pending` and its first `NOW` command equals `singularity-flow sync`, show it and explain it retries only the retained commit. Run `singularity-flow sync <WORK-ID>` once in the verified cwd, then stop; never follow `THEN`, invoke `/sf-nextsteps` or `/sf-next`, or retry.
4. Follow the selected skill; never rewrite it to `/sf-phase`. Pass only this invocation's verified packet and its input preview to the selected skill; do not repeat its boundary lookup. If the selected action is `/sf-code`, do not imitate or inline it: report `Next in Copilot: /sf-code` and stop; preserve `/sflow-code` likewise. Never publish a delegated action or chain another lifecycle action.
5. On failure run read-only `singularity-flow recover <WORK-ID> --phase <phase> --json`. Never add `--apply` without the reviewed plan and exact confirmation. `ARTIFACT_AUTHORING_INCOMPLETE` permits one recheck and correction handoff, not a retry loop.
6. Input/audit actions use returned metadata, not phase show or marker searches. Read exact returned paths only when needed; no broad repository/skill searches or tool-output archaeology.
7. Preserve returned telemetry, warnings, hashes and effects. Separate **Completed action** from **Next action**; never claim the next action was taken. Use the action result's `continuation`; only if absent run `singularity-flow nextsteps <WORK-ID> --for-agent --json` once. Copy the first `NOW` action's `copilotCommand` and `command` from that same action object and render `Next action (choose one surface):`, `Copilot: /sf-...`, `Shell: singularity-flow ...`. Never pair `/sf-phase` with `singularity-flow next`. Do not automatically submit a generation you just published.
8. After approval context `new`, run `/clear` and then `/sf-next`; after `compact`, run `/compact` and then `/sf-next`. After either reset, reapply the Boundary before artifact reads.
