---
name: sflow-integrations
description: Show what each workflow step sends to webhooks, logs, Teams, Jira, Git, Confluence or OneDrive after it is submitted, approved or rejected; retry deliveries that did not go out and record receipts for those that did.
disable-model-invocation: true
argument-hint: "[list | status | retry <DELIVERY-KEY...>|--all | record | test <TARGET>]"
---

# After-step deliveries

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Use this skill when someone asks what a step sends after approval, why a target did not hear about a step, how to send a delivery again, or how to show everyone that a delivery went out.

1. Run `singularity-flow integrations status --json` (add `--work-id <ID>` for one Story). Explain each open delivery: the step, the trigger, the target, its last outcome and when it is retried.
2. For configuration questions run `singularity-flow integrations list --json`. A secret shown as not set (names start with `SFLOW_SECRET_`) must be set in this machine's environment or in VS Code; never ask for a secret value in chat and never print one.
3. To check a target, run `singularity-flow integrations test <TARGET> --json` and show the request. Send a test only when the user asks, with `--send-test`.
4. Ask before mutation. When the user chooses to retry, run `singularity-flow integrations retry <KEY...> --json` (or `--all`) exactly once and report each outcome. If `reconstruction.restored` is nonempty, nothing was sent for those keys: show the unknown prior outcome and ask the user to check the receiver before authorizing another retry. Never auto-retry reconstruction.
5. To record what went out, on the checked-out Story whose deliveries they were, run `singularity-flow integrations record --dry-run --json` and show what it would commit; after the user agrees, run `singularity-flow integrations record --json` once. It is refused while a step awaits approval, because a commit then would require submitting that step again: say so and record after the decision.

6. When `prepare` or `finalize` is refused with `STEP_ACTION_REQUIRED_UNRECORDED`, a required action's approved delivery has no receipt: run only the command the refusal names (retry, record or sync), after asking.

Deliveries never change governed state, and a failed one never undoes a transition; only a required action holds the next step. Receipts are evidence only. `singularity-flow integrations deliver` is for pipelines (targets marked `deliverFrom: pipeline`); do not run it from chat. Changing targets or actions is a workflow change: use Workflow Studio or `/sf-configure`, not this skill.
