---
name: jira-work
description: List Jira stories assigned to the authenticated user or retrieve a specific Jira issue using Singularity Flow's direct Jira REST client. Use only on explicit request.
argument-hint: "[WORK-ID] [--project KEY] [--type Story]"
disable-model-invocation: true
---
# Jira work through Singularity Flow

No MCP server or IDE Jira plugin is used.

- List assigned work with `singularity-flow jira list` and supplied filters.
- Retrieve a specific item with `singularity-flow jira pull <WORK-ID>` (`show` remains an alias).
- Discover custom field IDs with `singularity-flow jira fields --query acceptance`, `--query story points`, or `--query sprint`.
- Start selected Jira work with `singularity-flow start <WORK-ID> --jira`.

Jira access requires `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN`. Never request the user's Atlassian password, display the token, or store credentials in Git.
