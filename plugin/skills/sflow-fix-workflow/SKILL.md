---
name: sflow-fix-workflow
description: Say whether a workflow is correct as the platform judges it, why not, and draft every fix as one reviewed Workflow Studio proposal.
disable-model-invocation: true
argument-hint: "[WORKFLOW]"

---
# Fix a workflow

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. This skill is already loaded; never call the skill tool for it. Unless paused, continue below in this turn.

<!-- sflow-output-contract: conversational-guidance -->
**Output contract:** Resolve ordinary language through durable Home and Next projections; reads may run immediately, while every mutation requires an explicit governed choice. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. After a blank line, display each next action as three separate Markdown bullets, in order: "- Copilot: `<copilotCommand>`", "- Shell: `<command>`", "- VS Code (model-free): `<modelFreeCommand>`". Preserve exact returned routes; never combine them on one line or in a table. Missing Copilot: "no verified equivalent"; missing Shell or model-free: "not available for this action". Never invent routes or make further calls for formatting.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.


Nothing changes until the proposal is reviewed and activated; you never approve or activate.

1. Run `singularity-flow workflow validate <WORKFLOW> --for-start --json` (exit 1 with findings is this skill's input, not a refusal) (no `<WORKFLOW>` checks all; `--for-start` reads the approved configuration a proposal changes). If `valid`, say so in two lines from `roles` (which step defines the clauses, plans each code step, carries the tags, reviews) and stop.
2. For each `problem` in `workflows[].findings` and `repository.findings`: what is wrong (`title`, `location`), why it stops a Story (`blocksStart`: Story start refuses it; else `stopsAt` names the step and when), and `fix.text`. Warnings get one line each; skip notes.
3. Ask with `ask_user` what is the person's to decide: which agent drafts a step, approval groups, whether a route may omit a responsibility and why, the wording of requirements. Offer choices from the findings and the repository; never invent people, groups or reasons. Never fix by removing a review, lowering approvals, or declaring omits without the person's reason and group.
4. Write every fix as one change set `{ "schema": <fixDraft.schema>, "changes": [...] }` to `fixDraft.changeSetPath` with a file-edit tool. Use a finding's `fix.changes` as given; otherwise Studio ops: `phase.agent` {phase, agent}, `phase.update` {id, workflow, approval: {groups, minimum, rejectTo}}, `workflow.update` {id, plannedClaims}, `template.update` {path: the finding's `subject.template`, content: the whole template, its wording kept, with the anchors or table the fix shows}. Run `singularity-flow workflow check <WORKFLOW> --change-set <fixDraft.changeSetPath> --json`: the targeted problems must be gone and none added. Repair the draft at most twice, then show what remains.
5. Run `singularity-flow workflow studio apply --change-set <fixDraft.changeSetPath> --dry-run --json` and show its `summary` and `files`. Only on the person's confirmation, run `singularity-flow workflow studio apply --change-set <fixDraft.changeSetPath> --propose --json` and report the proposal branch. The reviewer approves in Workflow Studio → Changes, or runs `singularity-flow configuration approve <BRANCH>` in their own terminal.
