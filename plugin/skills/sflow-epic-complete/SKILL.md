---
name: sflow-epic-complete
description: Validate every blocking Story against its approved specification and exact delivery evidence, then record the Product Owner's Epic completion decision.
---

# Complete an Epic

1. Run `singularity-flow epic complete <EPIC-KEY> --dry-run`.
2. Show every blocking Story, canonical source commit, submitted review packet, exact-SHA check evidence, conformance tree hash, and blocker. Do not hide failed or stale Stories.
3. If any Story is not ready, stop and give its next corrective action. Never weaken the configured checks.
4. When all Stories are ready, show the exact Product Owner decision that will be recorded and ask for the exact Epic key.
5. Run `singularity-flow epic complete <EPIC-KEY>` only with that explicit confirmation.
6. Print the complete `spec-to-code-completion.md` report, its content-addressed decision hash, commit, and push result.
7. State that configured-local Git identity is not cryptographic authentication and preserve all self-approval warnings.
