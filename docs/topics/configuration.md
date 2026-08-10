---
id: configuration
title: Configuration, capabilities, and the policy fold
aliases: [workflow-yml, sflow-config, capabilities, policy-fold]
related: [pins, quick-fix, escalation]
---
`main` holds application code; `sflow/config` holds approved configuration; a story branch receives an exact copy at creation. Configuration changes ride review branches with PR discipline — including capability-tree edits. The effective policy for a story is a fold: workflow defaults → work-type overrides → capability constraints (root to leaf), where later layers may tighten but never weaken — protected paths union, approval floors hold, a capability's self-approval ban cannot be re-allowed downstream. The fold runs once at start and pins; everything downstream reads the folded result.
