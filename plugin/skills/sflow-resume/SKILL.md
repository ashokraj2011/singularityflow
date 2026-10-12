---
name: sflow-resume
description: Resume an existing Singularity Flow work item by ID, check out its branch, load durable workflow state, and identify the correct SDLC phase.
disable-model-invocation: true
argument-hint: "<WORK-ID> [--fetch]"

---
# Resume Singularity Flow work

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow resume <arguments> --json`; work in its returned `repositoryPath` (it may switch to the Story's own worktree).
2. The CLI activates the current phase's default governed agent automatically. Do not ask the contributor to select a role. Use `/sf-agent` only when they explicitly request an override.
3. Read `workflow.json`, `STATUS.md`, source context, and approved artifacts from earlier phases.
4. The Repository brief is guidance: never run a World Model check or rebuild, and never wait for one; phase prompts include it, and `singularity-flow wm brief --phase <ACTIVE-PHASE>` shows it when asked.
5. Verify the returned branch matches the work ID; never judge it from the launch checkout.
6. Summarize the active governed agent, completed phases, active phase, rejection reason if present and required output. Keep the contributor's Git identity and approval authority separate.
7. Continue only in the active phase with the drafting route resume returned; do not skip ahead.
