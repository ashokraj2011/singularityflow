---
name: sflow-epic-requirements
description: Formalize pinned Epic sources into requirements, traceability, and repository impact analysis, then publish one governed Requirements bundle.
---

# Build the Epic Requirements bundle

1. Run `singularity-flow epic requirements status --json`. Epic Intake accepts the Jira identity and pinned sources automatically; do not build or request a repository world model on `main` or the Epic branch.
2. List pinned inputs with `singularity-flow epic sources list --epic <EPIC-KEY>`.
3. Record every business note with `epic sources note --text-file <FILE>` and every accepted Copilot answer with `epic sources answer --text-file <FILE>`. Never leave accepted answers only in chat history.
4. Run `singularity-flow epic requirements prepare`. Read the complete governed context that it prints: phase contract, persona, Jira snapshot, pinned sources, question ledger, and workspace repository registry. Repository grounding is added later, after each Story has its canonical branch.
5. Ask concise material questions. Record accepted answers, rebuild context, and continue. Unanswered questions stay visible but do not fabricate scope.
6. Author all three outputs: `requirements.md`, `traceability.yml`, and `impact-analysis.yml`. Use stable `REQ-nnn` and `AC-nnn` identifiers and cite exact `SRC-nnn` evidence.
7. Run `singularity-flow epic requirements publish`, show all three documents and hashes in full, and stop for review.
8. After explicit approval, run `singularity-flow epic requirements approve`. Never approve automatically.
