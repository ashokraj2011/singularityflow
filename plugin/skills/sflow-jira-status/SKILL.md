---
name: sflow-jira-status
description: Verify Singularity Flow's direct Jira connection, authenticated Jira identity, deployment type, and visible projects from Copilot CLI. Use only on explicit request.
disable-model-invocation: true
---

# Check Jira connection

Use Singularity Flow's direct Jira REST client. Do not use Jira MCP tools or ask the user to paste credentials into chat.

1. Run `singularity-flow jira status --json`.
2. Report:
   - connected or failed;
   - Jira base URL and Cloud/Data Center deployment;
   - authenticated display name and email when Jira returns it;
   - visible project keys;
   - the exact environment-variable names that are missing when configuration fails.
3. Never print an API token, PAT, Basic authorization header, or credential-store content.

CLI configuration:

- Jira Cloud: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`.
- Jira Data Center: `JIRA_BASE_URL`, `JIRA_DEPLOYMENT=data-center`, `JIRA_PAT`.

This skill is read-only. A successful response proves that the configured identity can reach Jira; it does not prove write permission for every project.
