---
name: sflow-integrations
description: Show what each workflow step sends to webhooks, log services and Teams after it is submitted, approved or rejected, and retry deliveries that did not go out.
disable-model-invocation: true
argument-hint: "[list | status | retry <DELIVERY-KEY...>|--all | test <TARGET>]"
---

# After-step deliveries

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Use this skill when someone asks what a step sends after approval, why a webhook, log service or Teams channel did not hear about a step, or how to send a delivery again.

1. Run `singularity-flow integrations status --json` (add `--work-id <ID>` for one Story). Explain each open delivery: the step, the trigger, the target, its last outcome and when it is retried.
2. For configuration questions run `singularity-flow integrations list --json`. A secret shown as not set must be set in this machine's environment or in VS Code; never ask for a secret value in chat and never print one.
3. To check a target, run `singularity-flow integrations test <TARGET> --json` and show the request. Send a test only when the user asks, with `--send-test`.
4. Ask before mutation. When the user chooses to retry, run `singularity-flow integrations retry <KEY...> --json` (or `--all`) exactly once and report each outcome.

Deliveries never change governed state, and a failed one never undoes a transition. Changing targets or actions is a workflow change: use Workflow Studio or `/sf-configure`, not this skill.
