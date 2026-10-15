---
name: sflow-phase-documents
description: Summarize phase documents and link their verified Markdown previews without reproducing bodies in chat.
disable-model-invocation: true
argument-hint: "[PHASE-ID]"
---
# View phase documents

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result lists `omittedFields` with exact line ranges in `agentOutput.path`; read only those you need with your file tool. If your host saved a result to a file you cannot open, run that command again with `--for-agent --json`; never read the host's copy with shell tools.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Select the explicit phase argument, or the current phase from the ready Story session. Run `singularity-flow phase show <PHASE-ID> --for-agent --json`. Stop if its Story or phase differs from the selected session, policy is unverified, or a document reports an error.
2. List each document's label, draft/published/submitted status, generation/hash and verified Markdown-preview link, with a brief supported summary. Distinguish unpublished drafts from published or submitted evidence. Do not paste bodies/code/diffs or expand every document merely for display. If a requested summary needs omitted text, read only that exact ID with `singularity-flow documents view <DOCUMENT-ID> --work-id <WORK-ID> --json`; disclose truncation. Use the host's Markdown preview when available; otherwise link the verified path without claiming it opened. Binary: metadata and verified open path. Never invent missing content or read another Story's file.
3. If no documents were produced, say so. This skill only reads; viewing is optional and does not submit, approve, or count as a review decision. End with `continuation.nextAction` on all three surfaces per the Output contract. `handoff` describes what follows publication, not what an unpublished draft can do now; never use it as the immediate action. Authoring, source review, human disposition, synchronization or recovery may precede Submit. If continuation is absent, read `singularity-flow nextsteps <WORK-ID> --for-agent --json` and relay its immediate action; never guess Submit or advance automatically.
