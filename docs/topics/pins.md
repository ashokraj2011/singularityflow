---
id: pins
title: Pins and the immutable resolution
aliases: [pinning, immutable-resolution, configuration-snapshot]
related: [configuration, story-lifecycle]
---
When a story starts, its rules are resolved once and pinned: phase sequence, templates, agents, approval authorities, checks, policies — hashes recorded, and configuration bytes physically copied from the `sflow/config` branch to the story branch. In-flight work continues under its exact starting contract even when repository configuration later changes; edits affect future stories only.

Pins answer the reproducibility question directly: show exactly which workflow, template, agent instructions, and policy produced this artifact. Budgets, escalation ladders, and study enrollment pin the same way — nothing governing active work is resolved from later configuration.
