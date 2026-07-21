---
name: release
description: Prepare the Singularity Flow release-readiness artifact with deployment, observability, rollback, communication, and final readiness decision.
argument-hint: "[target environment or release window]"
disable-model-invocation: true
---
# Release-readiness phase

1. Run `singularity-flow status --json`; stop if the current phase is not `release`.
2. Read all approved phase artifacts and deployment conventions.
3. Run `singularity-flow prepare release` and complete the release plan.
4. Include preconditions, deployment steps, migrations, flags, configuration, validation, metrics, alerts, success criteria, rollback triggers and steps, communication, ownership, and support escalation.
5. Remove placeholders and run `singularity-flow artifact scan`.
6. Do not submit or approve automatically.
