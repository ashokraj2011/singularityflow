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
version: 6
---
A workflow step can tell another system when it is submitted, approved or rejected: a webhook, a log service such as Splunk, Datadog, Elastic or Loki, a Microsoft Teams channel, the Story's Jira issue, a branch of another repository, or a Confluence page. Targets are declared once under `integrations.targets` in `singularity/workflow.yml`; steps list the actions that use them under `afterStep`. Configuration names secrets and never holds their values. A Story pins its actions when it starts, so later edits never change what a running Story sends.

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
    story-jira:
      kind: jira                  # the issue each Story was started from, unless issue: OPS-12 names one
      transition:                 # optional: one status for every trigger, or one per trigger
        submitted: In Review
        approved: Done
    approved-docs:
      kind: git
      repository: git@git.example.com:team/docs.git   # or https:// without a user or password
      branch: approved/specs                     # never an sflow/ branch
      path: specs/{story}/{step}/{file}          # optional; default sflow/{story}/{step}/{file}
    team-wiki:
      kind: confluence
      url: https://example.atlassian.net/wiki   # Data Center: its base address, with deployment: data-center
      parentPage: '123456'                      # pages are created under this page
      user: flow-bot@example.com                # Cloud only: the account the API token belongs to
      tokenSecret: SFLOW_SECRET_WIKI_TOKEN
      title: '{story} — {step}'                 # optional; {story}, {step} and {storyTitle}
phases:
  requirements:
    afterStep:
      - id: announce
        on: [submitted, approved, rejected]
        target: team-events
        send: event                # or summary: adds the artifact's title and acceptance criteria
```

A workflow replaces a shared step's list with `workTypes.<id>.phaseOverrides.<step>.afterStep`. Addresses must use `https://` (plain `http://` only to this machine) and carry no credentials; a target that is an internal service declares `network: private`. A Jira target uses the Jira connection of the machine that delivers (in VS Code, **Singularity Flow: Connect Jira Securely**; otherwise `JIRA_BASE_URL` with `JIRA_USERNAME` and `JIRA_PAT`), so it names no address or secret. It comments on the issue (`send: summary` adds the title and acceptance criteria), attaches the approved artifact when an action sends `artifact`, and then moves the issue to the status the target names for that trigger. When the repository's portfolio turns its Jira policy on, its allowed hosts and projects decide which issues a delivery may write to. A Git target commits the approved artifact (actions that send `artifact`) to a branch, fast-forward only, with the Git credentials of the machine that delivers. Each commit carries `Sflow-Delivery`, `Sflow-Story`, `Sflow-Step` and `Sflow-Generation` trailers: a retry that finds its trailer, or a newer generation of the same step, writes nothing, and a file that already holds the same bytes is not committed again. A Git target never writes to a branch of this repository that changes through review: its main, its Story branches or their base. A Confluence target keeps one page per Story and step under its parent page, with the summary or the approved artifact converted to Confluence's format (everything in the document is escaped text; it can never add markup or macros). A content property on the page records the delivery it holds, so a retry writes nothing and an older generation never writes over a newer one; a page with the same title elsewhere in the space is never taken over. Cloud uses the account email and an API token, Data Center a personal access token. OneDrive targets are refused until this build can deliver to them.

## Use it from each surface

- **Shell:** `singularity-flow integrations list` shows the targets, whether each secret is set on this machine, and which steps use them (`--work-id ID` shows what a Story pinned); `singularity-flow integrations status` lists deliveries not yet delivered (`--all` adds delivered ones); `singularity-flow integrations retry <KEY...>` or `--all` delivers now; `singularity-flow integrations test <TARGET>` shows the exact request with secrets redacted, and `--send-test` sends one marked as a test; for a Jira target it shows the comment, attachment and status change instead, and `--send-test` only checks that this machine can sign in and see the issue; for a Git target it shows the file and commit, and `--send-test` only checks that the repository and branch can be read; for a Confluence target it shows the page, and `--send-test` only reads the parent page.
- **Copilot:** `/sf-integrations` explains delivery status, checks a target's request, and retries deliveries after asking. It never asks for a secret value.
- **VS Code:** in Workflow Studio, **Integrations** adds, changes and removes targets, shows whether each secret is set on this machine, stores a secret in the keychain (**Store**), and, for a published target, previews the exact request or sends a test after you confirm. On the board, **Actions after this step** chooses what a step sends, to which target and when; the card shows it in its THEN lane. Actions belong to the workflow, like sign-off: on a step several workflows share, the others keep their own. For a Story, **Journey** lists what it pinned and every delivery on this machine with its last result, and retries one or all of them; after a step moves, a delivery that did not go out raises one notification with **Show deliveries** and **Retry now**.

## Guided workflow

1. Declare a target under `integrations.targets` (in Workflow Studio: **Integrations** → **Add a target**) and name its secret. Set that secret in this machine's environment, or store it from the target's card in VS Code.
2. Add an action to a step's `afterStep` with the triggers it fires on (in Workflow Studio: select the step → **Actions after this step** → **Add an action**).
3. Publish the configuration change. Stories started afterwards send the action; running Stories keep the actions they started with.
4. Run `singularity-flow integrations test <TARGET>` to see the request; add `--send-test` to send a sample (in Workflow Studio: **Preview the request** or **Send a test** on the target's card).
5. After a submit, approval or rejection, check `singularity-flow integrations status` (or the Story's Journey in VS Code) if a delivery was reported as not delivered.

## State and safety

Every action sends one JSON event (`sflow-step-action@1`): the Story id and title, the step and its generation, the trigger, who acted and when, the commit that records it, and each artifact's repository path and SHA-256. It never carries source code, diffs, prompts, secrets or paths on someone's machine; the Story's Jira issue key is included when it was started from Jira. An action that sends `artifact` also seals the approved artifact's bytes, checked against the hash the step recorded, into its delivery when the step moves, so later edits never change what is sent. Webhook requests carry `Idempotency-Key`, `X-SFlow-Trigger`, and, with a signing secret, `X-SFlow-Timestamp` and `X-SFlow-Signature: v1=<HMAC-SHA256 of "<timestamp>.<body>">`. Triggers follow the step's state: a submit that approved itself sends `approved`, and an approval below the step's threshold sends nothing.

Deliveries start after the governed commit is published; with publication `off` they start at once, and a commit that could not be pushed holds them until `singularity-flow sync` publishes it. Each delivery is written to this repository's action outbox on this machine and tried within the command's time budget. The same delivery is never sent twice: a Jira delivery records its key as an issue property and in its comment, and a retry finds either before it writes. A delivery never changes governed state or undoes a transition, and the outbox and activity log are machine-local, never governance evidence. `SINGULARITY_FLOW_NO_NETWORK=1` stops every delivery.

## Troubleshooting

- **Secret is not set on this machine:** the delivery waits without spending an attempt; set the secret and run `singularity-flow integrations retry --all`.
- **HTTP 5xx, 429 or a timeout:** the delivery is retried with backoff by later transitions, `sync` or `integrations retry`; after eight attempts it waits for a person.
- **HTTP 401, 403 or 404:** the target refused the request; fix its address or secret, then retry the delivery by its key.
- **Resolved to a private address:** a public target never reaches an internal address; declare `network: private` on a target that is an internal service.
- **Jira is not connected on this machine:** connect Jira (VS Code, or the `JIRA_*` variables) and retry; the delivery waits without spending an attempt.
- **The Story was not started from a Jira issue:** give the target an `issue`, or start Stories from Jira.
- **The issue cannot move to the status:** the workflow in Jira offers no such transition from where the issue is, or it asks for fields; move it in Jira, or change the target's `transition`.
- **The branch moved while a Git delivery was written:** someone pushed first; the delivery is retried on the new tip.
- **A Git target names a reviewed branch of this repository:** write to another branch or repository; main, the Story branches and their base change only through review.
- **A Confluence page with that title exists elsewhere in the space:** change the target's `title` or `parentPage`; a delivery never takes over a page it did not create under its parent.
- **A record no longer matches its seal:** it was changed on disk and is never delivered; it appears as tampered in `integrations status`.

## Related topics

- `singularity-flow explain configuration` for publishing workflow changes.
- `singularity-flow explain activity-and-prompt-audit` for the activity log that records each attempt.
- `singularity-flow explain copilot-and-surfaces` for Workflow Studio.
