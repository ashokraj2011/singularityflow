---
id: artifacts-and-generation
title: Artifacts, templates, and publication
aliases: [publish, generation, templates, clarifications]
commands: [phase, clarification, inputs, documents]
related: [manual-authorship, approvals, sequence-gates]
---
Phase artifacts are produced against pinned templates and published through the kernel: `sflow phase publish` validates the template contract, hashes the artifact (SHA-256), commits only allowlisted governed paths in one isolated commit, and advances the branch with compare-and-swap semantics — unrelated staged changes never enter lifecycle commits. Each publication is a numbered generation. With the AI: `/sflow-continue` composes the pinned context, asks unresolved questions first, then drafts. Inputs and reference documents are added with `sflow inputs add` / `sflow documents upload` and pinned by hash. Unresolved questions are not left in chat: `sflow clarification record` persists a question and its answer against the phase, and `sflow clarification status` shows what is still outstanding — so the next generation reads the answer as pinned context rather than rediscovering it.
