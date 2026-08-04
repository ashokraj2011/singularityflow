---
name: sflow-jira-doctor
description: Diagnose the active Singularity workspace Jira policy, CLI credentials, connection, project permissions, boards, and Epic visibility without changing Jira, Git, or repository files.
disable-model-invocation: true

---

# Diagnose Jira configuration

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.

This invocation is a strictly read-only Jira diagnostic.

## Strict execution boundary

- Your first and only tool call must be:

  `singularity-flow jira doctor --json`

- Do not search, glob, inspect, or read repository files yourself.
- Do not run workflow, phase, generation, approval, Jira update, Git commit, or Git push commands.
- Do not create, edit, or delete files.
- If the command exits with attention required, report its checks and next actions exactly; do not attempt repairs.
- Never display API tokens, PATs, authorization headers, or encrypted credential-store content.

Summarize:

- active workspace and selected repository;
- repository Jira policy and write mode;
- CLI credential availability, naming only missing variables;
- authenticated Jira identity and deployment;
- configured project visibility;
- permission, board, and Epic discovery;
- each recommended corrective action.

Explain that VS Code SecretStorage values are supplied only to commands launched by the extension. A separate terminal needs its own Jira environment variables.
