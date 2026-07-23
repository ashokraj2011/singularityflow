---
name: sflow-initiative-checklist
description: Review an initiative phase checklist, evidence assurance, freshness, applicability decisions, and blocking gates in GitHub Copilot.
argument-hint: "[PHASE] [--initiative INIT-ID]"
---
# Review an initiative checklist

1. Run `singularity-flow initiative checklist [PHASE] [--initiative INIT-ID] --json`.
2. Show every checklist ID, requirement, gate mode, status, accepted assurance levels, current evidence hashes, expiration, and reason.
3. Clearly separate blocking errors from warnings and optional items.
4. For unmet checks, show an exact `singularity-flow initiative evidence add <CHECK-ID> ...` example without inventing evidence or assurance.
5. Use `singularity-flow initiative verify [PHASE]` only when the contributor asks for current verification.

Never turn file presence into higher assurance and never record a waiver or not-applicable decision without explicit user intent.
