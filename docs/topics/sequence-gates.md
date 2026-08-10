---
id: sequence-gates
title: Sequence gates and submission
aliases: [gates, submit, refusal]
commands: [submit, validate, gate]
related: [reconciliation, approvals, nextsteps]
---
`sflow submit` checks the sequence gates — phase order, current generation, artifact published and pushed, hash match, required checks, final reconciliation — and refuses with a to-do list when any fail: each unmet gate, its evidence, and the exact repair command, closing with what was preserved ("Nothing was submitted. Nothing was lost."). Hard gates protect invariants and cannot be overridden; soft gates accept a typed, recorded override. `sflow validate` runs checks without side effects. On success the phase enters awaiting_approval and reviewers are notified with a link.
