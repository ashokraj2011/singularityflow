# ADR 0007: GDP command, transaction, and recovery contract

- Status: accepted for contract implementation; commands not installed
- Date: 2026-09-04
- Baseline: `main@70db564e`
- Decision owner: Singularity Flow repository maintainers

## Context

The GDP source proposal uses goal-shaped `start`, `run`, `review`, `decide`, and `publish` language,
but several names already exist and have compatibility obligations. It does not define an exact
confirmation grammar or show how its new records join the current publication transaction.

## Decision

M0 adds no command. Future GDP operations use `delivery`, `change`, `proof`, and the existing
`workflow migrate` namespace. Existing command grammar remains pinned to the subject runtime.
Goal-shaped aliases may be considered only after collision and compatibility work in GDP-M8.

All mutations use a read-only plan followed by operation-specific
`--plan sha256:<digest> --confirm-plan sha256:<same-digest>`. A plan binds subject, repository and
configuration revisions, operation, inputs, expiry, and authority. Stale or reused plans fail before
mutation.

GDP stages records through the existing subject lock and publication unit of work. Pre-commit
failure restores the captured preimage. Post-commit push failure retains the exact commit and
pending marker. Recovery publishes only that recorded commit, never ambient `HEAD`. A consequential
external effect is not blindly retried; indeterminate transport requires reconciliation or a human
decision.

Refusals carry stable codes, bounded typed metadata, preserved-state information, and one legal next
action. They exclude raw prompts, credentials, credentialed URLs, arbitrary terminal transcripts,
and home-directory paths.

## Consequences

GDP cannot bypass protected paths, approval, Candidate verification, or push recovery. A future
command implementation must prove no collision with legacy subjects and must expose the same plan,
refusal, and recovery in CLI, skills, and VS Code. The primary product wording may improve without
changing the durable authority boundary.
