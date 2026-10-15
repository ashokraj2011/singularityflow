---
name: sflow-explain
description: Explain one change, clause, test, line, gap or generation from cited, deterministic records.
disable-model-invocation: true
argument-hint: "change | clause --id ID | test --id ID | line --path PATH --line N [--side before|after] | gap | generation --phase PHASE --gen N [--for reviewer|auditor|developer]"
---
# Explain a change from cited records

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. A command's JSON is complete even when long: if your tool saved it to a file, read that file to its end before acting; never treat a saved or long result as truncated or stop because of its size.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. In the Boundary repository, use the first word of `$ARGUMENTS` as the subject. Run exactly one subject command:
   `singularity-flow explain --subject <SUBJECT> <REMAINING ARGUMENTS> --json`.
   Never guess a missing `--id`, `--path`, `--line` or `--gen`; ask the user for the exact value instead.
2. Relay the returned statements with their citation IDs, the `Needs attention` items, availability reasons, the
   `authority: none` label and the next actions unchanged. When `subject.status` is `ambiguous`, list its exact
   `choices` and ask which one; when it is `unavailable`, relay its reason code.
3. Stop. Never read or summarize source files yourself, call a clause satisfied, call a change mergeable, treat a
   region association or a test tag as proof, infer who wrote a line, or perform any lifecycle mutation.
