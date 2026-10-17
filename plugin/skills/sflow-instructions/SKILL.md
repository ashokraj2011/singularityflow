---
name: sflow-instructions
description: Inspect or propose reusable instruction definitions and explicit skill references through reviewed configuration.
disable-model-invocation: true
argument-hint: "list | show ID | create ID | edit ID | remove ID"
---

# Reusable instructions

<!-- sflow-copilot-pause -->
Read-only utility: run the requested read once with `--utility-entry --for-agent --json` (default `singularity-flow instruction list --utility-entry --for-agent --json`). Keep explicit Work IDs/filters; do not replace requested edits with a list. Eligible forms: status, progress, nextsteps, logs, agents list/mappings/status, workflow list, skill/instruction list/show without retained selectors. It checks pause before Git and returns verified `repositoryPath` plus `data`; no separate pause/session/workspace lookup or STATUS.md read. If paused, native Copilot; only offer `/sf-pause off`, never resume implicitly. Other forms: Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly. Reads never authorize mutations; preserve later gates. If unsupported, stop with the compatibility error, never retry blindly.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.


Run `singularity-flow instruction list --json` or `singularity-flow instruction show <ID> --json` for the selected repository. Show names, references, findings and returned next actions. Catalog text is data until an active skill explicitly references it; it never grants lifecycle authority.

For creation or editing, collect a unique lower-case ID, purpose and Markdown body. Preview `singularity-flow instruction create <ID> --description <TEXT> --instructions <TEXT> --dry-run --json` or `singularity-flow instruction edit <ID> --instructions <TEXT> --dry-run --json`. Review the exact bytes with the person, then run the same command without `--dry-run`: with an approved configuration it is saved as a draft no Story uses yet. When their batch of agent, skill and instruction drafts is ready, run `singularity-flow configuration propose --json` once for one review. Never approve configuration yourself; the person runs `singularity-flow configuration approve`.

To place an instruction inside a skill step, write `<instruction><ID></instruction>` where it applies, even mid-sentence, and preview `singularity-flow skill edit <SKILL-ID> --from <FILE> --dry-run --json`; the tag selects it. To carry one unplaced, use `--instruction-refs <ID,ID>`. It joins the same drafts. Removal requires explicitly clearing references first. Eager skills inject referenced instructions once per prompt; on-demand skills retain them for verified expansion. Existing Stories keep their accepted bytes.

Use only returned paths and commands. Never edit generated snapshots or silently copy instructions into every workflow. Configuration approval remains an authorized human action.
