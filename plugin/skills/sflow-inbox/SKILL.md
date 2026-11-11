---
name: sflow-inbox
description: Show what is waiting for your approval.
disable-model-invocation: true
agent: agent

---
# Open the pending approval inbox

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting. `ask_user` here is your host's question tool: `ask_user` in the Copilot CLI, `vscode_askQuestions` in VS Code; it is unavailable only when neither exists.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. Run `singularity-flow inbox --json`. This fetches the configured Git remote and reads committed work-item state without checking out every branch.
2. If `items` is empty, report that the remote approval inbox of the returned `repositoryPath` is clear, not the whole workspace: it reads one repository. In a multi-repository workspace offer `singularity-flow inbox --workspace <WORKSPACE-ID> --repository <ID> --json` for each other repository (`singularity-flow workspace status --json` lists them). Do not infer that uncommitted or unpublished work is ready for review.
3. Show every pending item with its work/Jira ID, title, phase, generation, approval count, waiting time, human authority groups, artifact path, remote commit, and self-approval warning.
4. Use Copilot's `ask_user` facility to let the contributor select one exact work/Jira ID. Never infer or preselect an item.
5. Run `singularity-flow session attach <WORK-ID> --json` once for that selection, then use its exact `repositoryPath`. It may create a tracking branch and fast-forward; never merge, rebase, reset, stash, or discard work. The phase agent does not change human authority. Do not attach again through `/sf-session`.
6. Run `singularity-flow phase show <PHASE> --for-agent --json`; retain current `reviewBinding` and `displayBinding`. Summarize the packet and list each artifact/brief's identity, generation/hash and verified Markdown-preview link; binary uses path/metadata. Never reproduce bodies/code/diffs. Tool output or summaries are not review; the human must review complete linked documents before approval.
7. Show current `reviewBinding`, identity/authority, checks and warnings. Document reuse never reuses approval consent. Mention `/sf-documents` for supporting evidence.
8. Stop. Offer `/sf-approve <PHASE-ID> --work-id <WORK-ID>` with actual IDs and `/sf-reject`; never decide or approve automatically.
