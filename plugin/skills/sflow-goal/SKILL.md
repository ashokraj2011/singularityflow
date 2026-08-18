---
name: sflow-goal
description: Create and manage personal workspace outcomes linked to governed work.
disable-model-invocation: true
argument-hint: "[create|list|show|next|use|link|unlink|complete|abandon]"

---
# Goals — outcomes above governed work

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.

A Goal is personal advisory state. It never changes a Story or Initiative lifecycle.

1. Start with `singularity-flow goal list --json`; durable workspace state, not chat memory, is authoritative. With no requested action, show the active Goal and run `singularity-flow goal next [GOAL-ID] --json` for one grounded recommendation.
2. For **create**, collect an outcome and at least one observable success criterion. Never invent a Work ID, repository, or kind. Preview the change and use `ask_user` before running:
   `singularity-flow goal create "<OUTCOME>" --success "<CRITERION>" [--success "<CRITERION>"] [--work-id <ID> --kind story|initiative --repository <ID>] --json`.
3. For **use**, **link**, or **unlink**, first show the Goal, require explicit Goal/Work selection, preview the local record change, and use `ask_user`. Linking validates but does not modify governed work.
4. For **complete**, show all criteria and live link states. Stop for active or unavailable links. Explain that completion is human acknowledgement—not proof or approval—then require the exact Goal ID and run `singularity-flow goal complete <GOAL-ID> --confirm <GOAL-ID> [--note "<NOTE>"] --json`.
5. For **abandon**, require a reason and exact ID; state that linked work is untouched before `ask_user` and `singularity-flow goal abandon <GOAL-ID> --reason "<REASON>" --confirm <GOAL-ID> --json`.
6. Preserve refusals and returned actions. Re-read after mutation. Route governed execution through the returned sibling skill; a Goal recommendation is not mutation consent.

Do not label a Goal “proved” or “fixed.” A future proof-goal flow must bind a typed oracle and evidence receipt; this skill currently records outcome goals only.
