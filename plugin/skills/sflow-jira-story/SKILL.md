---
name: sflow-jira-story
description: Pull one Jira user story by key through Singularity Flow's direct Jira REST client and present its normalized details without changing Jira or Git.
disable-model-invocation: true
argument-hint: "<JIRA-ID> [--json]"

---
# Pull a Jira user story

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Require an explicit Jira key; do not invent or guess one.
2. Run `singularity-flow jira pull <JIRA-ID>` with supplied arguments.
3. Report the exact summary, type, project, status, priority, assignee, reporter, parent, story points, sprint, dates, labels, components, description, acceptance criteria, subtasks, linked issues, and attachment metadata that were returned.
4. Clearly label fields that are absent. Do not infer missing acceptance criteria or requirements.
5. Do not create a branch, write repository files, modify Jira, or expose credentials.
6. When the user explicitly asks to begin work on the story, use `/sf-start <JIRA-ID> --jira`; that operation persists `source.json` and `USER-STORY.md` on the Story branch `/sf-start` reports.

Jira Cloud access requires `JIRA_BASE_URL`, `JIRA_EMAIL`, and `JIRA_API_TOKEN`; Jira Data Center requires `JIRA_BASE_URL`, `JIRA_DEPLOYMENT=data-center`, and `JIRA_PAT`. When the connection fails, offer `/sf-jira-doctor`. Optional custom-field IDs can be configured with `SINGULARITY_FLOW_JIRA_ACCEPTANCE_FIELD`, `SINGULARITY_FLOW_JIRA_STORY_POINTS_FIELD`, and `SINGULARITY_FLOW_JIRA_SPRINT_FIELD`.
