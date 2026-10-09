---
name: sflow-initiative-documents
description: List and display the full generated output documents for an initiative phase inside GitHub Copilot before review or approval.
disable-model-invocation: true
argument-hint: "[PHASE] [--initiative INIT-ID]"
---
# Show initiative documents

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Relay requested CLI fields or output faithfully; preserve warnings/errors and only the explanations required below. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Run `singularity-flow initiative documents [PHASE] [--initiative INIT-ID] --json`.
2. In the visible assistant response, reproduce every generated text document in full between `--- BEGIN <path> ---` and `--- END <path> ---`.
3. Precede each document with its output ID, kind, status, generation, byte count, and SHA-256.
4. A Shell/tool block is collapsible and does not satisfy document review. Never replace a document with a summary or say it was “shown above.”
5. For binary bundles, show metadata and the absolute local path instead of attempting text rendering.

Keep this operation read-only.
