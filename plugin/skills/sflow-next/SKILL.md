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
3. Follow the selected skill; never rewrite it to `/sf-phase`. When the selected action is `/sf-code`, do not imitate or inline it; report `Next in Copilot: /sf-code` and stop. For deterministic convergence, run only returned `singularity-flow prepare convergence`; inspect that result's `next[]` action and stop for the human. Run no model; publish only if preparation returns `convergence.publish`. For other generation report the selected skill and stop. Never publish a delegated action.
4. For non-delegated publication, run the returned exact configured-producer command once; never change producer/channel. Confirm sanitized `telemetry/<phase>-gen<N>.json`; use `--usage-json` only for exact usage.
5. On failure run `singularity-flow recover <WORK-ID> --phase <phase> --json`. On `ARTIFACT_AUTHORING_INCOMPLETE`, use `/sf-phase` to repair every finding and retry once only after the artifact fingerprint changes. Never launch nested Copilot. Stop on a second refusal or unchanged fingerprint.
6. Run `singularity-flow phase show <phase> --json`; show bounded reference-previews and hash-bound references. Expand source only on request; for binary show path/metadata/open instruction.
7. Report action, commit/push, authority, agent, telemetry, resolved model, token/cost status, and next action. Do not automatically submit a generation you just published. Show `Next in Copilot: /sf-...`, then `Terminal equivalent: singularity-flow ...`.
8. Obey approval `Context boundary`: for `new`, tell the contributor to run `/clear` and then `/sf-next`; for `compact`, run `/compact` then `/sf-next`. After either reset, reapply the Boundary before artifact reads.
