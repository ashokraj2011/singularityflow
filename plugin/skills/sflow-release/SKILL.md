---
name: sflow-release
description: Prepare the Singularity Flow release-readiness artifact with deployment, observability, rollback, communication, and final readiness decision.
argument-hint: "[target environment or release window]"
disable-model-invocation: true
---
# Release-readiness phase

1. Run `singularity-flow status --json`; stop if the current phase is not `release`.
2. Ground the phase with `singularity-flow wm context release --task "<release target>" --concat --evidence --no-persona`. If missing or stale, run `singularity-flow wm build --phase release --task "<release target>"`, then rerun context. Use release, operations, security, and evidence views.
3. Run `singularity-flow wm inject --phase release` and use the returned, rule-grounded persona prompt.
4. Read all approved phase artifacts and the deployment locations selected by the grounding package.
5. Run `singularity-flow prepare release` and complete the release plan.
6. Include preconditions, deployment steps, migrations, flags, configuration, validation, metrics, alerts, success criteria, rollback triggers and steps, communication, ownership, and support escalation.
7. Remove placeholders and run `singularity-flow phase publish release`.
8. Do not submit or approve automatically.
