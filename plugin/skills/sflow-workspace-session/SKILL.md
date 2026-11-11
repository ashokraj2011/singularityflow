---
name: sflow-workspace-session
description: Attach the current terminal or Copilot session to a saved Singularity Flow workspace before selecting Story work.
disable-model-invocation: true
agent: agent

---
# Attach this session to a workspace

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting. Where the steps say ask_user, use your host's question tool: ask_user in the Copilot CLI, vscode_askQuestions in VS Code; it is unavailable only when neither exists.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

This is context setup only. Do not inspect application files, start implementation, generate artifacts, or advance lifecycle state.

1. Run `singularity-flow workspace list --json` from the current directory. This command uses the machine-local workspace registry and does not require the Singularity Flow source repository or an application repository to be open.
2. If the contributor supplied an exact workspace ID, name, Jira anchor, or directory, verify it appears in the list. Otherwise use `ask_user` to let them choose one; never infer a workspace from the folder that happens to be open.
3. If the contributor supplied a repository ID or Story ID, preserve it exactly. Otherwise do not invent one.
4. Run `singularity-flow session workspace <WORKSPACE> [--repository <ID>] [--story <ID>] --json`.
5. Report the returned workspace, repository path, Story selection, prompt label, and `hostAction`.
6. When `hostAction` is `reopen-repository`, explain that a child command cannot change the parent Copilot or VS Code process's working directory. In VS Code run **Singularity Flow: Attach Copilot Session to Workspace**. From a terminal run the returned `commands.openCopilot` command. Do not claim the current host changed directory.
7. When a Story is selected, use `/sf-session <STORY-ID>` only after Copilot is rooted in the returned repository. When no Story is selected, stop after reporting that the workspace is active.
8. End the turn. Workspace attachment is never an implicit request to implement work.
