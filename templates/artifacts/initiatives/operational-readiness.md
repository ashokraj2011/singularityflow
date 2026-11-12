<!-- singularity-flow:initiative-metadata
{{metadata}}
-->

# {{initiative.id}} — {{output.label}}

<!-- sflow:guidance Whether this can be run in production by the people who will have to run it. Each claim names the evidence behind it; "yes" without evidence is an assertion, not readiness. -->

## Ownership

<!-- sflow:guidance Who owns this once it is live, and who is called when it breaks. -->

| Service / component | Owning team | On-call rota | Escalation |
|---|---|---|---|

## Observability

<!-- sflow:guidance What can be seen from outside the system, and whether it exists today. -->

| Signal | Type | Exists | Where | Alerts on |
|---|---|---|---|---|
| | metric / log / trace | yes / no | | |

## Alerting

<!-- sflow:guidance Each alert states what a responder should do. An alert with no action is noise. -->

| Alert | Condition | Severity | Response | Runbook |
|---|---|---|---|---|

## Quality and security controls

| Control | Required by | Status | Evidence |
|---|---|---|---|

## Failure and recovery

| Failure mode | Impact | Detection | Recovery | Tested? |
|---|---|---|---|---|

## Capacity and cost

<!-- sflow:guidance Expected load, headroom, and what this costs to run. -->

| Dimension | Expected | Limit | Cost basis |
|---|---|---|---|

## Rollback

<!-- sflow:guidance The exact steps to undo this in production, and how long they take. State explicitly if rollback is not possible — that is a decision to be taken knowingly, not discovered during an incident. -->

## Support readiness

<!-- sflow:guidance What support and operations need before this ships. -->

| Need | Status | Owner |
|---|---|---|

## Outstanding risks

<!-- sflow:guidance Accepted risks going into production, and who accepted them. -->

| Risk | Severity | Accepted by | Mitigation |
|---|---|---|---|

## Evidence

{{inputs}}
