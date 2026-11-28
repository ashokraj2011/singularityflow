---
name: sflow-jira-doctor
description: Diagnose the active Singularity workspace Jira policy, CLI credentials, connection, project permissions, boards, and Epic visibility without changing Jira, Git, or repository files.
disable-model-invocation: true
agent: agent

---

# Diagnose Jira configuration

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). A turn that ends with nothing left for SFlow ends with "/sf-next carries it on" (or press Continue).
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

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
