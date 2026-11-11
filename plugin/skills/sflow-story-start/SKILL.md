---
name: sflow-story-start
description: Select a Jira Story, workflow, and prompt-only governed agent, then create or resume its canonical governed branch.
disable-model-invocation: true
agent: agent
argument-hint: "<JIRA-STORY-KEY>"

---
# Start a governed Jira Story

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. Never show a person a hash, digest or commit SHA: name the step, its generation, its files. Each action: "<timing> — <label>", then its three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Keep returned routes exact; never apart from their label, on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make more calls for formatting. Where the steps say ask_user, use your host's question tool: ask_user in the Copilot CLI, vscode_askQuestions in VS Code; it is unavailable only when neither exists.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

1. No key: run `singularity-flow jira assigned --type Story --json`; ask the contributor to choose. Never infer it.
2. Run `singularity-flow jira pull <STORY-KEY> --json`; show its details before mutation.
3. Verify its Jira project routes to this repository or active workspace; otherwise switch first.
4. Run `singularity-flow workspace branches --entry --intake --work-id <STORY-KEY> --for-agent --json` once; list unrelated changes it reports and stop until the person lands (`/sf-adhoc`) or moves them.
5. Run `singularity-flow workspace branches --json`. Present branches published by every required delivery repository and require a choice; stop if a remote fails. Ask separately for optional **read-only reference repositories**. Each requires an explicit lower-kebab ID, credential-free Git URL, and branch and becomes paired `--reference-repository ID=URL --reference-branch ID=BRANCH` options. Never infer one or describe it as a delivery repository. Ask for baseline (`reuse`, reviewed `run`, `defer`), tests (`changed-and-affected`, `all-configured`) and gates (`hard`; `soft` needs human coverage-risk review, reason, expiry) separately; never default them silently. Start `singularity-flow story start <STORY-KEY> --fetch --from-branch <SELECTED-BRANCH> --readiness-baseline <CHOICE> --test-execution-mode <MODE> --gate-mode <GATES>` interactively and bridge workflow choices through `ask_user`. If the chosen workflow's `targetUrl` is `required` (start refuses without it) or `recommended`, ask for its authorized target and pass `--target-url <AUTHORIZED-URL>`.
6. If persistent terminal input is unavailable:
   - Run `singularity-flow choices begin start <STORY-KEY> --for-agent --json`.
   - Present and record `base-branch`; never preselect it.
   - Record `jira` for `intake-source`.
   - Present the workflow-template and governed-agent options with `ask_user`.
   - Record answers with `singularity-flow choices answer`.
   - When ready, run `singularity-flow story start <STORY-KEY> --fetch --selection-receipt <TOKEN>` plus the step 5 policy flags; add step 5's `--target-url` when given.
7. Show the Epic → Jira Story → canonical branch lineage, base/commit, workflow, agent, phase, outputs, commit, and push status of the Story ref. Verify the base ref did not move.
8. The Repository brief is guidance: never run a World Model check or rebuild, and never wait for one; Story context comes from the governed workflow and never becomes a world-model task guide; `/sf-phase` composes the brief.
9. Continue only when asked; offer `/sf-phase` and read-only `/sf-nextsteps`.

The canonical branch is the returned `workItem.branch`; `--ref` or `git.branchNaming.pattern` may differ from the Jira key. Intake pins the issue snapshot in Git without updating Jira or approving. Main/workspace/Epic intake never requires or warns about a world model.

TRP: read and follow `singularity-flow explain test-recovery`; returned legal actions only.
