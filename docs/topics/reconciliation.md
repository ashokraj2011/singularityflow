---
id: reconciliation
title: Reconciliation and dispositions
aliases: [reconcile, dispositions, update-intent]
commands: [story]
related: [work-intervals, escalation, sequence-gates]
---
`sflow story interval reconcile` deterministically compares reality against the starting contract: claimed vs. changed paths, protected paths, required checks bound to the exact commit, clause coverage. Verdicts: clear · attention · blocked · incomplete — and `clear` explicitly does not claim semantic correctness. Findings are facts; a human chooses what they mean: `aligned`, `continue-work`, `update-intent` (the plan was wrong — the affected phase reopens for a corrected intent and your code stays; the diff becomes evidence for the new intent, not auto-approved), `record-deviation`, or `escalate`. Final submission requires a clean reconciliation bound to the submitted commit.
