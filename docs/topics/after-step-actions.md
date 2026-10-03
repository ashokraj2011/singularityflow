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
version: 10
---
A workflow step can tell another system when it is submitted, approved or rejected: a webhook, a log service such as Splunk, Datadog, Elastic or Loki, a Microsoft Teams channel, the Story's Jira issue, a branch of another repository, a Confluence page, or a OneDrive or SharePoint folder. Targets are declared once under `integrations.targets` in `singularity/workflow.yml`; steps list the actions that use them under `afterStep`. Configuration names secrets and never holds their values. A Story pins its actions when it starts, so later edits never change what a running Story sends.

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
    team-drive:
      kind: onedrive
      drive: b!Xy3kLibraryDriveId               # the document library drive
      site: contoso.sharepoint.com,<id>,<id>    # optional: the SharePoint site of that library
      folder: Specs/{story}/{step}/generation-{generation}   # optional; must include {generation}
      tokenSecret: SFLOW_SECRET_GRAPH_TOKEN     # a Microsoft Graph access token
phases:
  requirements:
    afterStep:
      - id: announce
        on: [submitted, approved, rejected]
        target: team-events
        send: event                # or summary: adds the artifact's title and acceptance criteria
      - id: audit
        on: [approved]
        target: audit-log
        required: true             # the next step waits until this approved delivery has a receipt
```

A workflow replaces a shared step's list with `workTypes.<id>.phaseOverrides.<step>.afterStep`. An action marked `required: true` must fire on `approved`; it holds the Story after its step until that approved delivery has a receipt in the Story (see State and safety). Addresses must use `https://` (plain `http://` only to this machine) and carry no credentials; a target that is an internal service declares `network: private`. A Jira target uses the Jira connection of the machine that delivers (in VS Code, **Singularity Flow: Connect Jira Securely**; otherwise `JIRA_BASE_URL` with `JIRA_USERNAME` and `JIRA_PAT`), so it names no address or secret. It comments on the issue (`send: summary` adds the title and acceptance criteria), attaches the approved artifact when an action sends `artifact`, and then moves the issue to the status the target names for that trigger. When the repository's portfolio turns its Jira policy on, its allowed hosts and projects decide which issues a delivery may write to. A Git target commits the approved artifact (actions that send `artifact`) to a branch, fast-forward only, with the Git credentials of the machine that delivers. Each commit carries `Sflow-Delivery`, `Sflow-Story`, `Sflow-Step` and `Sflow-Generation` trailers: a retry that finds its trailer, or a newer generation of the same step, writes nothing, and a file that already holds the same bytes is not committed again. A Git target never writes to a branch of this repository that changes through review: its main, its Story branches or their base. A Confluence target keeps one page per Story and step under its parent page, with the summary or the approved artifact converted to Confluence's format (everything in the document is escaped text; it can never add markup or macros). A content property on the page records the delivery it holds, so a retry writes nothing and an older generation never writes over a newer one; a page with the same title elsewhere in the space is never taken over. Cloud uses the account email and an API token, Data Center a personal access token. A OneDrive target uploads the approved artifact through Microsoft Graph to its folder, which always includes the generation, so an older generation never replaces a newer upload; an upload never replaces a file that is already there, which is how a repeat is recognised. The token is a Graph access token someone provides; it expires, and a delivery refused for it waits for a fresh one.

## Use it from each surface

- **Shell:** `singularity-flow integrations list` shows the targets, whether each secret is set on this machine, and which steps use them (`--work-id ID` shows what a Story pinned); `singularity-flow integrations status` lists deliveries not yet delivered (`--all` adds delivered ones); `singularity-flow integrations retry <KEY...>` or `--all` delivers now; `singularity-flow integrations test <TARGET>` shows the exact request with secrets redacted, and `--send-test` sends one marked as a test; for a Jira target it shows the comment, attachment and status change instead, and `--send-test` only checks that this machine can sign in and see the issue; for a Git target it shows the file and commit, and `--send-test` only checks that the repository and branch can be read; for a Confluence target it shows the page, and `--send-test` only reads the parent page; for a OneDrive target it shows where the file goes, and `--send-test` only reads the drive. `singularity-flow integrations record` commits a receipt for each of the checked-out Story's deliveries that went out (`--dry-run` shows them first), and `singularity-flow integrations deliver --commit <SHA>` delivers a pushed commit's pipeline targets in a pipeline.
- **Copilot:** `/sf-integrations` explains delivery status, checks a target's request, and retries deliveries or records receipts after asking. It never asks for a secret value.
- **VS Code:** in Workflow Studio, **Integrations** adds, changes and removes targets, shows whether each secret is set on this machine, stores a secret in the keychain (**Store**), and, for a published target, previews the exact request or sends a test after you confirm. On the board, **Actions after this step** chooses what a step sends, to which target and when, and **Required** makes the next step wait for the approved delivery; the card shows it in its THEN lane. Actions belong to the workflow, like sign-off: on a step several workflows share, the others keep their own. For a Story, **Journey** lists what it pinned and every delivery on this machine with its last result, and retries one or all of them; it says when the next step waits for a required delivery, marks each delivery whose receipt is recorded, and **Record receipts** commits the rest. After a step moves, a delivery that did not go out raises one notification with **Show deliveries** and **Retry now**.

## Guided workflow

1. Declare a target under `integrations.targets` (in Workflow Studio: **Integrations** → **Add a target**) and name its secret. Set that secret in this machine's environment, or store it from the target's card in VS Code.
2. Add an action to a step's `afterStep` with the triggers it fires on (in Workflow Studio: select the step → **Actions after this step** → **Add an action**).
3. Publish the configuration change. Stories started afterwards send the action; running Stories keep the actions they started with.
4. Run `singularity-flow integrations test <TARGET>` to see the request; add `--send-test` to send a sample (in Workflow Studio: **Preview the request** or **Send a test** on the target's card).
5. After a submit, approval or rejection, check `singularity-flow integrations status` (or the Story's Journey in VS Code) if a delivery was reported as not delivered.
6. When the deliveries went out and no step awaits approval, run `singularity-flow integrations record` on the machine that delivered them, so the Story records what was sent.

## State and safety

Every action sends one JSON event (`sflow-step-action@1`): the Story id and title, the step and its generation, the trigger, who acted and when, the commit that records it, and each artifact's repository path and SHA-256. It never carries source code, diffs, prompts, secrets or paths on someone's machine; the Story's Jira issue key is included when it was started from Jira. An action that sends `artifact` also seals the approved artifact's bytes, checked against the hash the step recorded, into its delivery when the step moves, so later edits never change what is sent. Webhook requests carry `Idempotency-Key`, `X-SFlow-Trigger`, and, with a signing secret, `X-SFlow-Timestamp` and `X-SFlow-Signature: v1=<HMAC-SHA256 of "<timestamp>.<body>">`. Triggers follow the step's state: a submit that approved itself sends `approved`, and an approval below the step's threshold sends nothing.

Deliveries start after the governed commit is published; with publication `off` they start at once, and a commit that could not be pushed holds them until `singularity-flow sync` publishes it. Each delivery is written to this repository's action outbox on this machine and tried within the command's time budget. The same delivery is never sent twice: a Jira delivery records its key as an issue property and in its comment, and a retry finds either before it writes. A delivery never changes governed state or undoes a transition, and the outbox and activity log are machine-local, never governance evidence. `SINGULARITY_FLOW_NO_NETWORK=1` stops every delivery.

Receipts are the shared record. `singularity-flow integrations record` writes one immutable receipt (`step-action-receipt`) per delivery that went out under the Story's `evidence/step-actions/`, in one `external-synchronized` commit. A receipt names the delivery key, the step, generation and trigger, the action and its target, the commit of the transition, the hash of the event that was sent and of the pinned target, and when it was delivered after how many attempts. Only a delivery that matches what the Story pinned, whose transition commit is on this branch, becomes a receipt; a repeat records nothing new. Recording is refused while a step awaits approval, because any commit during review would require submitting that step again; record after the decision.

A required action holds the Story: `prepare` of any later step, and `finalize` after the last one, refuse with `STEP_ACTION_REQUIRED_UNRECORDED` until the step's approved delivery of that action has a committed receipt for the generation that was approved. The refusal says what to run from what this machine knows: `singularity-flow integrations retry <KEY>` for a delivery that failed or is still retrying, `singularity-flow integrations record` for one that went out from here, `singularity-flow sync` for one waiting for its commit to be published, and nothing when this machine has no record of it, because the machine that approved the step delivers it. The machine that delivers a required action records its receipt at once, after `approve`, a `submit` that approves itself, `integrations retry` and `sync`, so a hold normally means the delivery did not go out. A receipt counts only when HEAD holds it. While a step is held, `singularity-flow nextsteps`, `singularity-flow status` and the Journey and lifecycle tree in VS Code show that delivery as the next action, and `publish` and `submit` of the held step refuse like `prepare`.

### Delivering from a pipeline

A target can be delivered by a pipeline instead of the person who moves the Story: set `deliverFrom: pipeline` on it (in Workflow Studio, **Delivered by: A pipeline**). The machine that submits, approves or rejects the step then writes the delivery as the pipeline's and never sends it; `integrations status` and the Journey show it as delivered by a pipeline. A pipeline that holds the organisation's credentials runs on every push to a Story branch:

```yaml
# A job on each push to a Story branch, with Singularity Flow installed and the branch checked out
# with its history. The pipeline's Git identity and push right are needed only for --record.
steps:
  - run: git checkout -B "$BRANCH" "origin/$BRANCH"
  - run: singularity-flow integrations deliver --commit "$PUSHED_SHA" --record
    env:
      SFLOW_SECRET_AUDIT_TOKEN: ${{ secrets.SFLOW_SECRET_AUDIT_TOKEN }}   # the target's secret
```

`singularity-flow integrations deliver --commit <SHA>` reads the commit's lifecycle event (the one its `Singularity-Flow-Event-SHA256` trailer binds), the Story state and artifact bytes in that commit, and sends what the transition calls for to pipeline targets, with the same delivery keys, so a receiver sees each delivery once. It trusts nothing a Story branch can change: it delivers an action only when the target the Story pinned is exactly the one the approved configuration declares on the trusted ref, which is the remote's default branch unless `--trusted-ref` names another. A commit that is not a lifecycle commit delivers nothing. The job fails when a delivery did not go out. With `--record` and the Story's branch checked out, it commits the receipts too (not while a step awaits approval), so a required pipeline action releases the next step once people run `singularity-flow refresh-branch`.

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
- **Microsoft Graph refused the token:** Graph tokens expire; store a fresh one (VS Code: Workflow Studio, Integrations, Store), then retry.
- **A step cannot be prepared, or the Story finalized, because a required after-step action has no receipt:** run what the refusal names. A failed delivery: fix the target and run `singularity-flow integrations retry <KEY>`, which records the receipt when it goes out. One that went out from this machine: `singularity-flow integrations record`. When this machine has no record of it, the person who approved the step delivers and records it.
- **A step waits for a pipeline delivery:** the pipeline delivers it and records its receipt; check its job, then run `singularity-flow refresh-branch` to bring the receipt in.
- **The pipeline says a target is not trusted:** the target the Story pinned differs from the approved configuration on the trusted ref, because the target changed after the Story started or the branch changed it. The pipeline never sends it; someone with the secret can deliver it from their machine with `singularity-flow integrations retry <KEY>`.
- **Recording receipts is refused while a step awaits approval:** a commit during review would make the submission stale; record after the step is approved or sent back.
- **A delivery is not recorded:** `integrations record` names the reason, for example a transition commit that is not on this branch or an action the Story did not pin.
- **A record no longer matches its seal:** it was changed on disk and is never delivered; it appears as tampered in `integrations status`.

## Related topics

- `singularity-flow explain configuration` for publishing workflow changes.
- `singularity-flow explain activity-and-prompt-audit` for the activity log that records each attempt.
- `singularity-flow explain copilot-and-surfaces` for Workflow Studio.
