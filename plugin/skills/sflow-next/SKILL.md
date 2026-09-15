---
name: sflow-next
description: Execute one valid Singularity Flow lifecycle action without chaining later actions.
disable-model-invocation: true

---
# Execute the next workflow action

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.

One action; human approval only.

1. First run `singularity-flow session current --json`; require `ready`/`workId`, and use its returned `repositoryPath` as cwd for every subsequent command. Run `singularity-flow nextsteps <WORK-ID> --json` there; refuse `ACTIVE_SUBJECT_MISMATCH`. `singularity-flow wm ensure` needs explicit consent. Never derive `--task`; use the shared repository model. Do not start it while waiting.
2. Never run `singularity-flow next`. Load one returned SFlow skill route (any `/sf-*` or `/sflow-*` route), use its configured producer/channel, complete its preflight, execute at most its one authorized action, and stop. Before approval run `singularity-flow phase show <phase> --json`; validate authority, report the automatic phase agent, and require the exact phase name. Every recorded approval must produce its own commit and push.
3. Sole no-skill exception: when snapshot `state=publication_pending` and its first `NOW` command equals `singularity-flow sync`, show it and explain it retries only the retained commit. Run `singularity-flow sync <WORK-ID>` once in the verified cwd. Stop; never follow `THEN`, invoke `/sf-nextsteps` or `/sf-next`, or retry.
4. Follow the selected skill; never rewrite it to `/sf-phase`. If the selected action is `/sf-code`, do not imitate or inline it; report `Next in Copilot: /sf-code` and stop. Treat `/sflow-code` the same and preserve it. Authoring skills must draft-check and correct every agent finding now. Never publish a delegated action.
5. On failure run the read-only `singularity-flow recover <WORK-ID> --phase <phase> --json`. Do not add `--apply` without a separately reviewed recovery plan and its exact confirmation. `ARTIFACT_AUTHORING_INCOMPLETE` allows one recheck and correction handoff, not a retry loop.
6. Run `singularity-flow phase show <phase> --json`; show bounded source previews, hash-bound references, and binary paths/metadata.
7. Preserve the CLI-returned sanitized `telemetry/<phase>-gen<N>.json`; report resolved model and token/cost status, action, commit/push, authority, and agent. End with `Next in Copilot: /sf-...` and `Terminal equivalent: singularity-flow ...`; never invent operands. Do not automatically submit a generation you just published.
8. On approval `Context boundary` `new`, run `/clear` and then `/sf-next`; on `compact`, run `/compact` and then `/sf-next`. After either reset, reapply the Boundary before artifact reads.
