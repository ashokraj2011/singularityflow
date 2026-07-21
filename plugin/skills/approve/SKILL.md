---
name: approve
description: Explicitly approve the submitted Singularity Flow phase, snapshot artifacts, record the human approver, advance the workflow, and normally commit the approved phase.
argument-hint: "[--by 'Name'] [--no-commit]"
disable-model-invocation: true
---
# Approve the submitted phase

This explicit skill invocation is the human approval boundary. It does not authorize push, merge, deployment, or Jira updates. In repositories where `governance.requireGithubApprovals` is true, local approval is intentionally unavailable as a trust mechanism.

1. Run `singularity-flow status --json`; verify the current phase is `awaiting_approval`.
2. Show the work ID, branch, phase, required artifact, registered artifacts, checks, and warnings.
3. Read `.sdlc/config.json`. If `governance.requireGithubApprovals` is true, tell the user to comment `/approve <phase>` on the work item's pull request; do not run the local approval command.
4. Otherwise, if the user supplied `--no-commit`, run `singularity-flow approve --yes <other-arguments>`.
5. Otherwise use the durable local default: `singularity-flow approve --yes --commit <other-arguments>`.
6. Never add `--yes` outside this explicitly invoked approval skill or the trusted GitHub approval workflow.
7. Run `singularity-flow status` afterward and report the next phase or completion.
8. Do not push, merge, deploy, or modify Jira unless separately requested.
