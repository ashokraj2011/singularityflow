---
name: sflow-initiative-documents
description: List and display the full generated output documents for an initiative phase inside GitHub Copilot before review or approval.
argument-hint: "[PHASE] [--initiative INIT-ID]"
---
# Show initiative documents

1. Run `singularity-flow initiative documents [PHASE] [--initiative INIT-ID] --json`.
2. In the visible assistant response, reproduce every generated text document in full between `--- BEGIN <path> ---` and `--- END <path> ---`.
3. Precede each document with its output ID, kind, status, generation, byte count, and SHA-256.
4. A Shell/tool block is collapsible and does not satisfy document review. Never replace a document with a summary or say it was “shown above.”
5. For binary bundles, show metadata and the absolute local path instead of attempting text rendering.

Keep this operation read-only.
