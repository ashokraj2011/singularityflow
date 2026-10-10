---
name: sflow-phase-documents
description: Show the documents produced by a Story phase for review before submission.
disable-model-invocation: true
argument-hint: "[PHASE-ID]"
---
# View phase documents

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Select the explicit phase argument, or the current phase from the ready Story session. Run `singularity-flow phase show <PHASE-ID> --json`. Stop if its Story or phase differs from the selected session, policy is unverified, or a document reports an error.
2. Show each produced document's ID, label, kind, path, generation, size and SHA-256, and the phase status. Distinguish unpublished drafts from published or submitted evidence. Render its returned text in full when available. For a bounded preview or omitted body, read that exact ID with `singularity-flow documents view <DOCUMENT-ID> --work-id <WORK-ID> --json`; state clearly if the verified preview is truncated. For a binary, show its metadata and verified open path. Never invent missing content or read a different Story's file.
3. If no documents were produced, say so. This skill only reads; viewing is optional and does not submit, approve, or count as a review decision. End with `continuation.nextAction` and its exact Shell/Copilot pair. `handoff` describes what follows publication, not what an unpublished draft can do now; never use it as the immediate action. Authoring, source review, human disposition, synchronization or recovery may precede Submit. If continuation is absent, read `singularity-flow nextsteps <WORK-ID> --json` and relay its immediate action; never guess Submit or advance automatically.
