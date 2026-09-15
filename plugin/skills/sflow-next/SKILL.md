---
name: sflow-next
description: Execute one valid Singularity Flow lifecycle action without chaining later actions.
disable-model-invocation: true

---
# Execute the next workflow action

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

Execute one lifecycle action and stop. Never loop through approvals; only human identity grants approval authority.

1. Run `singularity-flow session current --json`; require `ready`, retain its subject, then run `singularity-flow nextsteps <WORK-ID> --json` in that cwd. Refuse `ACTIVE_SUBJECT_MISMATCH`. An optional `singularity-flow wm ensure ...` is only an offer; it never delays ordinary work. Never derive `--task`; lifecycle grounding uses the shared repository model. Run model construction only after explicit consent. Do not start it while waiting. Then run `singularity-flow next` once and follow its result.
2. Let CLI synchronization, submission, gate, or approval finish. Before approval run `singularity-flow phase show <phase> --json`, validate reviewer authority, report the automatic phase agent, and require the exact phase name. Every recorded approval must produce its own commit and push.
3. Follow the selected skill; never rewrite it to `/sf-phase`. If the selected action is `/sf-code`, do not imitate or inline it; report `Next in Copilot: /sf-code` and stop. Other authoring skills must draft-check and correct every agent finding now. Never publish a delegated action.
4. For deterministic convergence, run `singularity-flow prepare convergence`, inspect that result's `next[]`, and publish only if preparation returns `convergence.publish`. Draft-check first; regenerate, never edit/model-author, and stop unchanged or after three fingerprints.
5. Before non-delegated publication, draft-check. Route agent correction to `/sf-phase` and other producers to their owner/regenerator. Never delete/invent/pad or nest models. When ready, run the exact configured producer/channel once.
6. On failure run `recover`. Race-time `ARTIFACT_AUTHORING_INCOMPLETE` permits one recheck and correction handoff, not an internal publication retry loop.
7. Run `singularity-flow phase show <phase> --json`; show bounded reference-previews and hash-bound references. Expand source only on request; for binary show path/metadata/open instruction.
8. Preserve sanitized `telemetry/<phase>-gen<N>.json` without raw traces or conversation identifiers. Report action, commit/push, authority, agent, resolved model and token/cost status. End `Next in Copilot: /sf-<action>` then `Terminal equivalent: singularity-flow <action>`. Do not automatically submit a generation you just published.
9. Obey approval `Context boundary`: for `new`, tell the contributor to run `/clear` and then `/sf-next`; for `compact`, run `/compact` then `/sf-next`. After either reset, reapply the Boundary before artifact reads.
