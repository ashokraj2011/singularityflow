---
name: sflow-initiative-documents
description: List and display the full generated output documents for an initiative phase inside GitHub Copilot before review or approval.
disable-model-invocation: true
argument-hint: "[PHASE] [--initiative INIT-ID]"
---
# Show initiative documents

<!-- sflow-output-contract: concise-relay -->
**Output contract:** Return the named CLI command output verbatim; do not elaborate, re-narrate, or hide errors.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow initiative documents [PHASE] [--initiative INIT-ID] --json`.
2. In the visible assistant response, reproduce every generated text document in full between `--- BEGIN <path> ---` and `--- END <path> ---`.
3. Precede each document with its output ID, kind, status, generation, byte count, and SHA-256.
4. A Shell/tool block is collapsible and does not satisfy document review. Never replace a document with a summary or say it was “shown above.”
5. For binary bundles, show metadata and the absolute local path instead of attempting text rendering.

Keep this operation read-only.
