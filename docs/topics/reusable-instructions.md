---
id: reusable-instructions
title: Reusable instructions referenced by skills
aliases:
  - instruction-library
  - instructions
commands:
  - instruction
related:
  - skill-master
  - workflow-authoring
  - importing-assets
version: 1
---

Open Configuration → Instructions to create, edit or inspect reusable Markdown guidance. Definitions are kept at `singularity/instruction-library/<id>/INSTRUCTIONS.md`. In Skills, select the definitions that skill uses. Preview exact configuration changes and obtain human approval before activation.

Use `singularity-flow instruction list --json`, `singularity-flow instruction show <ID> --json`, or `/sf-instructions`. Propose a definition with `singularity-flow instruction create <ID> --description <TEXT> --from <FILE> --dry-run --json`. Connect it with `singularity-flow skill edit <SKILL-ID> --instruction-refs <ID,ID> --dry-run --json`.

These are not global Copilot `applyTo` instructions: an active skill explicitly selects them. Workflow skills remain workflow-local; agent skills follow their agent. Shared definitions render once. On-demand skills retrieve their retained definitions only when explicitly expanded. Stories retain exact accepted bytes, unaffected by later catalog changes.

Workflow export/import and independent duplication carry and rename definitions with skill references. Missing definitions require configuration repair, not live replacement of Story snapshot bytes. Definitions cannot grant approvals or override workflow policy. Clear references before removal, or include the explicit skill reference edits in the same Studio proposal.
