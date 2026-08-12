---
id: fast-path-verbs
title: The five verbs
aliases: [fast-path, specify, spec-driven, five-verbs]
commands: [specify, plan, implement, verify, converge]
related: [story-lifecycle, starting-work, approvals, nextsteps]
---
`spec-driven-standard` Stories are driven by five verbs: `sflow specify`, `plan`, `implement`, `converge`, `verify`. Each is a router, not an autopilot — it resolves the subject, phase, generation, pending publication and approval state, then runs only the registered kernel operations that are legal before the next checkpoint and stops. A checkpoint is any boundary needing model generation, consent, human review, approval, external completion, or recovery. The verbs orchestrate; they never reimplement lifecycle rules, compute competing state, or bypass a transition, so the authoritative result is identical to running the underlying phase commands by hand. Every response names the milestone it is working toward, the checkpoint it stopped at, and the underlying operations — so a small vocabulary never hides which governed operation ran. A milestone counts only when workflow state proves it; a command returning successfully is not completion. Pending publication is routed before any new work. The advanced phase commands remain available and unchanged.
