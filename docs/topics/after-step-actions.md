---
id: after-step-actions
title: After-step actions and integrations
aliases:
  - integrations
  - step-actions
  - webhooks
  - deliveries
related:
  - copilot-and-surfaces
  - configuration
  - activity-and-prompt-audit
commands:
  - integrations
version: 2
---
A workflow step can send an event to another system when it is submitted, approved or rejected: a webhook, a log service such as Splunk, Datadog, Elastic or Loki, or a Microsoft Teams channel. Targets are declared once under `integrations.targets` in `singularity/workflow.yml`; steps list the actions that use them under `afterStep`. Configuration names secrets and never holds their values. A Story pins its actions when it starts, so later edits never change what a running Story sends.

## Purpose and prerequisites

Use this topic to tell other systems about a step's decisions: a team channel, an audit log, or an internal service that records approvals. Targets and actions are workflow configuration, so add them through Workflow Studio or the normal reviewed configuration change. Each secret a target names must be set in the environment of the machine that delivers: VS Code passes the secrets it stores, and a pipeline passes its own. Secret names start with `SFLOW_SECRET_`, so a workflow can only read values someone set up for it and never another tool's credentials, such as `JIRA_PAT` or `GITHUB_TOKEN`.

```yaml
integrations:
  targets:
    team-events:
      kind: webhook
      url: https://hooks.example.com/sflow
      signingSecret: SFLOW_SECRET_EVENTS_KEY
    audit-log:
      kind: http-log
      format: splunk-hec          # json, splunk-hec, datadog, elastic or loki
      url: https://logs.example.com/services/collector
      tokenSecret: SFLOW_SECRET_SPLUNK_TOKEN
    team-channel:
      kind: teams
      urlSecret: SFLOW_SECRET_TEAMS_URL
phases:
  requirements:
    afterStep:
      - id: announce
        on: [submitted, approved, rejected]
        target: team-events
        send: event                # or summary: adds the artifact's title and acceptance criteria
```

A workflow replaces a shared step's list with `workTypes.<id>.phaseOverrides.<step>.afterStep`. Addresses must use `https://` (plain `http://` only to this machine) and carry no credentials; a target that is an internal service declares `network: private`. Jira, Git, Confluence and OneDrive targets are refused until this build can deliver to them.

## Use it from each surface

- **Shell:** `singularity-flow integrations list` shows the targets, whether each secret is set on this machine, and which steps use them (`--work-id ID` shows what a Story pinned); `singularity-flow integrations status` lists deliveries not yet delivered (`--all` adds delivered ones); `singularity-flow integrations retry <KEY...>` or `--all` delivers now; `singularity-flow integrations test <TARGET>` shows the exact request with secrets redacted, and `--send-test` sends one marked as a test.
- **Copilot:** `/sf-integrations` explains delivery status, checks a target's request, and retries deliveries after asking. It never asks for a secret value.
- **VS Code:** in Workflow Studio, **Integrations** adds, changes and removes targets, shows whether each secret is set on this machine, stores a secret in the keychain (**Store**), and, for a published target, previews the exact request or sends a test after you confirm. On the board, **Actions after this step** chooses what a step sends, to which target and when; the card shows it in its THEN lane. Actions belong to the workflow, like sign-off: on a step several workflows share, the others keep their own.

## Guided workflow

1. Declare a target under `integrations.targets` (in Workflow Studio: **Integrations** → **Add a target**) and name its secret. Set that secret in this machine's environment, or store it from the target's card in VS Code.
2. Add an action to a step's `afterStep` with the triggers it fires on (in Workflow Studio: select the step → **Actions after this step** → **Add an action**).
3. Publish the configuration change. Stories started afterwards send the action; running Stories keep the actions they started with.
4. Run `singularity-flow integrations test <TARGET>` to see the request; add `--send-test` to send a sample (in Workflow Studio: **Preview the request** or **Send a test** on the target's card).
5. After a submit, approval or rejection, check `singularity-flow integrations status` if a delivery was reported as not delivered.

## State and safety

Every action sends one JSON event (`sflow-step-action@1`): the Story id and title, the step and its generation, the trigger, who acted and when, the commit that records it, and each artifact's repository path and SHA-256. It never carries source code, diffs, prompts, secrets or paths on someone's machine. Webhook requests carry `Idempotency-Key`, `X-SFlow-Trigger`, and, with a signing secret, `X-SFlow-Timestamp` and `X-SFlow-Signature: v1=<HMAC-SHA256 of "<timestamp>.<body>">`. Triggers follow the step's state: a submit that approved itself sends `approved`, and an approval below the step's threshold sends nothing.

Deliveries start after the governed commit is published; with publication `off` they start at once, and a commit that could not be pushed holds them until `singularity-flow sync` publishes it. Each delivery is written to this repository's action outbox on this machine and tried within the command's time budget. The same delivery is never sent twice. A delivery never changes governed state or undoes a transition, and the outbox and activity log are machine-local, never governance evidence. `SINGULARITY_FLOW_NO_NETWORK=1` stops every delivery.

## Troubleshooting

- **Secret is not set on this machine:** the delivery waits without spending an attempt; set the secret and run `singularity-flow integrations retry --all`.
- **HTTP 5xx, 429 or a timeout:** the delivery is retried with backoff by later transitions, `sync` or `integrations retry`; after eight attempts it waits for a person.
- **HTTP 401, 403 or 404:** the target refused the request; fix its address or secret, then retry the delivery by its key.
- **Resolved to a private address:** a public target never reaches an internal address; declare `network: private` on a target that is an internal service.
- **A record no longer matches its seal:** it was changed on disk and is never delivered; it appears as tampered in `integrations status`.

## Related topics

- `singularity-flow explain configuration` for publishing workflow changes.
- `singularity-flow explain activity-and-prompt-audit` for the activity log that records each attempt.
- `singularity-flow explain copilot-and-surfaces` for Workflow Studio.
