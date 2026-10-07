---
name: sflow-workspace-session
description: Attach the current terminal or Copilot session to a saved Singularity Flow workspace before selecting Story work.
disable-model-invocation: true

---
# Attach this session to a workspace

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** machine-local; no repository or Story required. Use explicit arguments or SFlow-returned paths; never search `$HOME` or infer a repository.

This is context setup only. Do not inspect application files, start implementation, generate artifacts, or advance lifecycle state.

1. Run `singularity-flow workspace list --json` from the current directory. This command uses the machine-local workspace registry and does not require the Singularity Flow source repository or an application repository to be open.
2. If the contributor supplied an exact workspace ID, name, Jira anchor, or directory, verify it appears in the list. Otherwise use `ask_user` to let them choose one; never infer a workspace from the folder that happens to be open.
3. If the contributor supplied a repository ID or Story ID, preserve it exactly. Otherwise do not invent one.
4. Run `singularity-flow session workspace <WORKSPACE> [--repository <ID>] [--story <ID>] --json`.
5. Report the returned workspace, repository path, Story selection, prompt label, and `hostAction`.
6. When `hostAction` is `reopen-repository`, explain that a child command cannot change the parent Copilot or VS Code process's working directory. In VS Code run **Singularity Flow: Attach Copilot Session to Workspace**. From a terminal run the returned `commands.openCopilot` command. Do not claim the current host changed directory.
7. When a Story is selected, use `/sf-session <STORY-ID>` only after Copilot is rooted in the returned repository. When no Story is selected, stop after reporting that the workspace is active.
8. End the turn. Workspace attachment is never an implicit request to implement work.
