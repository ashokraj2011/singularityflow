---
id: manual-authorship
title: Manual authorship and working without AI
aliases: [authored-human, no-model-authoring, from-file]
commands: [phase]
related: [model-independence, artifacts-and-generation]
---
`sflow phase publish --authored human --from ./design.md` gives hand-written artifacts the same pipeline: template validation, hashing, the standard transaction, approvals, evidence. The record states precisely what is known: the kernel invoked no model. External AI use defaults to `unknown` and can be attested only as self-reported — the system never infers AI authorship from style. Imported files are hashed before copying, written atomically to the pinned artifact path, and any forged lifecycle metadata inside them is stripped.
