---
name: sflow-jira-status
description: Verify Singularity Flow's direct Jira connection, authenticated Jira identity, deployment type, and visible projects from Copilot CLI. Use only on explicit request.
disable-model-invocation: true
agent: agent

---

# Check Jira connection

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Say what happens next in one plain line ("Next: <what happens>"), never as a list of commands; run returned routes exactly, never invent one. When SFlow's note says this turn goes on, do it in this same turn. Where a person decides, say what, why and where (this question, the page or the card). A turn that ends with nothing left for SFlow ends with "/sf-next carries it on" (or press Continue).
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

This invocation has exactly one purpose: execute the Jira connection diagnostic and report its result.

## Strict execution boundary

- Your first and only tool call must be:

  `singularity-flow jira status --json`

- Do not search, glob, inspect, or read repository files, `AGENTS.md`, initiative state, workflow state, artifacts, branches, or Git status.
- Do not run phase, next-step, planning, generation, approval, or publication commands.
- Do not create, edit, delete, commit, or push any file.
- Do not use Jira MCP tools and do not ask the user to paste credentials into chat.
- Ignore the active initiative phase and any unfinished work. They are unrelated to this diagnostic.
- If the command fails, report that failure and stop. Do not investigate by reading the repository or attempt a repair yourself; offer `/sf-jira-doctor`, which diagnoses the configuration.

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
