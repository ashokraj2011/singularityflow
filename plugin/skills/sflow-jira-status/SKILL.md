---
name: sflow-jira-status
description: Verify Singularity Flow's direct Jira connection, authenticated Jira identity, deployment type, and visible projects from Copilot CLI. Use only on explicit request.
disable-model-invocation: true

---

# Check Jira connection

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.

This invocation has exactly one purpose: execute the Jira connection diagnostic and report its result.

## Strict execution boundary

- Your first and only tool call must be:

  `singularity-flow jira status --json`

- Do not search, glob, inspect, or read repository files, `AGENTS.md`, initiative state, workflow state, artifacts, branches, or Git status.
- Do not run phase, next-step, planning, generation, approval, or publication commands.
- Do not create, edit, delete, commit, or push any file.
- Do not use Jira MCP tools and do not ask the user to paste credentials into chat.
- Ignore the active initiative phase and any unfinished work. They are unrelated to this diagnostic.
- If the command fails, report that failure and stop. Do not investigate by reading the repository and do not attempt a repair.

After the command completes, report:

   - connected or failed;
   - Jira base URL and Cloud/Data Center deployment;
   - authenticated display name and email when Jira returns it;
   - visible project keys;
   - the exact environment-variable names that are missing when configuration fails.

Never print an API token, PAT, Basic authorization header, or credential-store content.

CLI configuration:

- Jira Cloud: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`.
- Jira Data Center: `JIRA_BASE_URL`, `JIRA_DEPLOYMENT=data-center`, `JIRA_PAT`.

This skill is strictly read-only. A successful response proves that the configured identity can reach Jira; it does not prove write permission for every project.
