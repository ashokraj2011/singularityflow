---
name: sflow-release
description: Prepare the Singularity Flow release-readiness artifact with deployment, observability, rollback, communication, and final readiness decision.
disable-model-invocation: true
argument-hint: "[target environment or release window]"

---
# Release-readiness phase

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow status --json`; stop if the current phase is not `release`. Use that governed workflow as Story context.
2. Run `singularity-flow wm compose --phase release --evidence` and use the complete returned prompt. If composition reports unavailable World-Model intelligence—missing or unreachable, or stale under staleness `fail`—continue with its explicit zero-context evidence and ordinary repository access. Show any exact returned recovery command only as an optional improvement; do not run it from this skill or make it a prerequisite for release work. Never add the Story title or a conversational release target as `--task`. Use available shared release, operations, security, and evidence grounding.
3. Read all approved phase artifacts and the deployment locations selected by the grounding package.
4. Run `singularity-flow prepare release` and complete the release plan.
5. Include preconditions, deployment steps, migrations, flags, configuration, validation, metrics, alerts, success criteria, rollback triggers and steps, communication, ownership, and support escalation.
6. Remove placeholders and run the exact configured-producer `singularity-flow phase publish release ...` command printed by `prepare`; never invent producer or channel flags.
7. Run `singularity-flow phase show release --json`, then reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, with its ID, kind, byte count, and hash. A collapsible Shell/tool block does not count. Never say “shown above.” Never replace it with a summary. For binary documents, show the absolute path, metadata, and open instruction.
8. Do not submit or approve automatically. End with `Next in Copilot: /sf-submit release`, followed by `Terminal equivalent: singularity-flow submit release`.
