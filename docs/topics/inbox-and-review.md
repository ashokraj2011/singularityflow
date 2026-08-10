---
id: inbox-and-review
title: The inbox and review packets
aliases: [inbox, review-packet, reviewers]
commands: [inbox, review, report]
related: [approvals, epics-and-planning]
---
`sflow inbox` lists every phase awaiting approval in the repository, labeled by authority group — computed from remote branches, so it needs only a clone: no workspace, no local setup. (`sflow workspace` aggregates a capability's repositories for multi-repo reviewers — a convenience, never a prerequisite.)

The review packet shows the exact artifact and hash, provenance (inputs, grounding, authorship — including whether the kernel invoked a model), clause coverage against acceptance criteria, reconciliation findings, prior generations, and — for mobile work — visual coverage and pixel evidence. In VS Code: Approvals (Inbox), Open Artifact, Open Reconciliation, Specification Traceability, Open Journey. `sflow report --format html` renders a shareable status page.
