---
id: what-is-singularity-flow
title: What is Singularity Flow
aliases: [overview, about, singularityflow]
related: [pins, story-lifecycle, model-independence]
---
Singularity Flow is a Git-native lifecycle kernel: it lets AI participate in the SDLC without letting AI become the source of truth. Prompts, agents, and workflow YAML are the authoring layer; beneath them, a deterministic CLI (`sflow`) owns state transitions, artifact hashing, approvals, publication transactions, and recovery. Lifecycle state lives on work-item Git branches — any machine reconstructs the same truth from a clone.

The model proposes, drafts, and narrates; it cannot approve, cannot invent an executable action, and cannot change lifecycle state. A model's statement never changes truth — the kernel validates every claimed transition. The positioning in one line: prompts generate work; Singularity Flow proves what work happened, under which rules, using which evidence, and who authorized it.
