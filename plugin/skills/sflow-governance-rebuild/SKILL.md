---
name: sflow-governance-rebuild
description: Preview and deliberately rebuild this repository's governance onto the current Singularity Flow model.
disable-model-invocation: true
argument-hint: "[--dry-run]"

---
# Rebuild this repository's governance

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

A rebuild replaces every framework-owned workflow, template and agent with the
installed package, keeps every repository-owned definition byte-identical,
recompiles every workflow under the current rules, and archives every existing
Story. It never touches application code, tests or documents.

1. Run `singularity-flow governance rebuild --dry-run --json` first.
2. Show the complete plan: `plan`, the configuration source and commit, every
   `replaced` file with its old and new digest, `removed`, `kept`, every
   workflow with its owner and status, every failing workflow's findings and
   repair action, every Story with its branch tips, and every blocker. Do not
   summarize away files, workflows or Stories.
3. If `blockers` is not empty, stop: the plan cannot be confirmed. Relay each
   blocker and its repair, then preview again after the contributor repairs it.
4. Otherwise ask the contributor whether to proceed. A failing repository
   workflow listed in `inactive` stays byte-identical and unstartable until it
   is repaired; the confirmation must name it with `--accept-inactive`.
5. Only after the contributor gives the exact plan digest, run the returned
   `next` command with `--json` and show `commit`, `receipt`, `archived`,
   `backup` and `invariants`. Tell them to push the branch for teammates.
6. To undo a rebuild, run `singularity-flow governance restore --plan <PLAN>
   --dry-run --json`, show every file, and confirm only with their consent.

Never supply a confirmation yourself, infer consent from the original request,
edit a workflow to make it pass, commit, push, or delete a branch. If the CLI
refuses, relay its code and repair and stop.
