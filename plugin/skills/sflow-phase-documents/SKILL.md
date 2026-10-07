---
name: sflow-phase-documents
description: Show the documents produced by a Story phase for review before submission.
disable-model-invocation: true
argument-hint: "[PHASE-ID]"
---
# View phase documents

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. For suggested actions, pair Shell with the returned Copilot command; honor `commandGuidance`. If absent, say "Copilot: no verified equivalent"; never invent a slash command.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

1. Select the explicit phase argument, or the current phase from the ready Story session. Run `singularity-flow phase show <PHASE-ID> --json`. Stop if its Story or phase differs from the selected session, policy is unverified, or a document reports an error.
2. Show each produced document's ID, label, kind, path, generation, size and SHA-256. Render its returned text in full when available. For a bounded preview or omitted body, read that exact ID with `singularity-flow documents view <DOCUMENT-ID> --work-id <WORK-ID> --json`; state clearly if the verified preview is truncated. For a binary, show its metadata and verified open path. Never invent missing content or read a different Story's file.
3. If no documents were produced, say so. This skill only reads; viewing is optional and does not submit, approve, or count as a review decision. Preserve the phase's returned next action, including Submit when available.
