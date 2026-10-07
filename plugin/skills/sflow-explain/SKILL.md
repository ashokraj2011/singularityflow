---
name: sflow-explain
description: Explain one change, clause, test, line, gap or generation from cited, deterministic records.
disable-model-invocation: true
argument-hint: "change | clause --id ID | test --id ID | line --path PATH --line N [--side before|after] | gap | generation --phase PHASE --gen N [--for reviewer|auditor|developer]"
---
# Explain a change from cited records

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. In the Boundary repository, use the first word of `$ARGUMENTS` as the subject. Run exactly one subject command:
   `singularity-flow explain --subject <SUBJECT> <REMAINING ARGUMENTS> --json`.
   Never guess a missing `--id`, `--path`, `--line` or `--gen`; ask the user for the exact value instead.
2. Relay the returned statements with their citation IDs, the `Needs attention` items, availability reasons, the
   `authority: none` label and the next actions unchanged. When `subject.status` is `ambiguous`, list its exact
   `choices` and ask which one; when it is `unavailable`, relay its reason code.
3. Stop. Never read or summarize source files yourself, call a clause satisfied, call a change mergeable, treat a
   region association or a test tag as proof, infer who wrote a line, or perform any lifecycle mutation.
