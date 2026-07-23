---
name: sflow-jira-initiative
description: Browse Jira Epics and child stories, preview their repository mapping, adopt an Epic into a Singularity initiative, or prepare a governed outbound Jira write plan.
---

# Jira initiative bridge

Use this skill when a contributor wants to browse Jira hierarchy or connect an existing Jira Epic to a Singularity initiative.

## Safety contract

- Never ask the user to paste an API token or PAT into Copilot chat.
- Prefer the Electron **Jira workspace** for sign-in; it stores credentials through the operating-system keychain.
- CLI credentials must already exist in the user environment or protected secret manager.
- Read operations may run directly.
- Always preview Epic adoption before changing initiative state.
- Never invent repository ownership. Ask the user to map every unresolved Jira child to a configured repository.
- Never run `jira-apply` without showing the complete plan, its SHA-256, and the exact fields affected.
- Jira status, assignee, sprint, priority, and resolution are outside this connector’s write scope.

## Read flow

1. Run `singularity-flow jira status`.
2. List permitted projects with `singularity-flow jira projects`.
3. List project Epics with `singularity-flow jira epics --project <KEY>`.
4. Show children with `singularity-flow jira children <EPIC-KEY>`.

## Adoption flow

1. Confirm that the current Git branch is the target initiative branch.
2. Preview:

   `singularity-flow initiative jira-adopt <EPIC-KEY> --repository <JIRA-KEY>=<REPO> --dry-run`

3. Display both identifier columns: Singularity Work ID and Jira ID.
4. Resolve every missing repository mapping with the user.
5. Run the same command without `--dry-run`.
6. Report the committed source snapshot hash, branch commit, and push result.

## Outbound write flow

1. Run `singularity-flow initiative jira-plan`.
2. Display every operation, subject, and field plus the exact plan SHA-256.
3. Explain that `jira.writeMode: approved` and an approved Plan/Elaboration phase are required.
4. Ask the user to confirm the exact initiative ID and exact plan hash.
5. Only then run `singularity-flow initiative jira-apply --plan <SHA-256>`.
6. Display each Jira key and the committed receipt/push result.

Do not transition issues automatically. Do not treat Jira as workflow state; committed Git records remain canonical.
