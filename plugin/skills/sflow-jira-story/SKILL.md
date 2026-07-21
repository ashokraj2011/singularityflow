---
name: sflow-jira-story
description: Pull one Jira user story by key through Singularity Flow's direct Jira REST client and present its normalized details without changing Jira or Git.
argument-hint: "<JIRA-ID> [--json]"
disable-model-invocation: true
---
# Pull a Jira user story

1. Require an explicit Jira key; do not invent or guess one.
2. Run `singularity-flow jira pull <JIRA-ID>` with supplied arguments.
3. Report the exact summary, type, project, status, priority, assignee, reporter, parent, story points, sprint, dates, labels, components, description, acceptance criteria, subtasks, linked issues, and attachment metadata that were returned.
4. Clearly label fields that are absent. Do not infer missing acceptance criteria or requirements.
5. Do not create a branch, write repository files, modify Jira, or expose credentials.
6. When the user explicitly asks to begin work on the story, use `/sflow-start <JIRA-ID> --jira`; that operation persists `source.json` and `USER-STORY.md` on the exact Jira-ID branch.

Jira access requires `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN`. Optional custom-field IDs can be configured with `SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD`, `SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD`, and `SINGULARITY_FLOW_JIRA_SPRINT_FIELD`.
