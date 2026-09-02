---
name: sflow-next
description: Execute the single next valid Singularity Flow action, including grounded phase generation, submission, interactive approval, publication recovery, or final governance.
disable-model-invocation: true

---
# Execute the next workflow action

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → verified `ready`/`workId`, cwd=`repositoryPath`; never `$HOME`; `singularity/work-items/<WORK-ID>/`.

Execute one lifecycle action and stop. Never loop through approvals; only human identity grants approval authority.

1. Run `singularity-flow session current --json`; require `ready`, retain its subject, and in that cwd run `singularity-flow nextsteps <WORK-ID> --json`. Refuse `ACTIVE_SUBJECT_MISMATCH`. If it names `singularity-flow wm ensure`, explain that a repository-reading/file-writing Copilot agent may start and get explicit consent. Do not start it while waiting. On consent run it, then `singularity-flow next`; otherwise stop. Never derive `--task`; lifecycle grounding uses the shared repository model.
2. Let CLI synchronization, submission, gate, or approval finish. Before approval run `singularity-flow phase show <phase> --json`, validate reviewer authority, report the automatic phase agent, and require the exact phase name. Every recorded approval must produce its own commit and push.
3. Follow the exact selected skill; never rewrite it to `/sf-phase`. When the selected action is `/sf-code`, do not imitate or inline it: report `Next in Copilot: /sf-code` with the phase and stop. For deterministic convergence, run only returned `singularity-flow prepare convergence`, inspect that result's `next[]`, relay `convergence.adjudicate`, `convergence.rework`, or `convergence.intent-amendment`, and stop for the human. Run no model; publish only if preparation returns `convergence.publish`. For other generation report the selected skill and stop. Never publish a delegated action.
4. For non-delegated publication, run the returned exact configured-producer command once; never change producer/channel. Confirm sanitized `telemetry/<phase>-gen<N>.json`; use `--usage-json` only for exact usage.
5. On failure run `singularity-flow recover <WORK-ID> --phase <phase> --json`. On `ARTIFACT_AUTHORING_INCOMPLETE`, use `/sf-phase` to repair every finding and retry once only after the artifact fingerprint changes. Never launch nested Copilot. Stop on a second refusal or unchanged fingerprint.
6. Run `singularity-flow phase show <phase> --json`; show bounded reference-previews and hash-bound references. Expand source only on request; for binary show path/metadata/open instruction.
7. Report action, commit/push, authority, agent, telemetry, resolved model, token/cost status, and next action. Do not automatically submit a generation you just published. Show `Next in Copilot: /sf-...`, then `Terminal equivalent: singularity-flow ...`.
8. Obey approval `Context boundary`: for `new`, tell the contributor to run `/clear` and then `/sf-next`; for `compact`, run `/compact` then `/sf-next`. After either reset, reapply the Boundary before artifact reads.
