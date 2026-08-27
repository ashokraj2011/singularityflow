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

Execute one lifecycle action, report its durable Git result, and stop. Never loop through approvals. Human identity grants approval authority.

1. Run `singularity-flow session current --json`; require `ready`, retain its subject fields, and from that cwd run `singularity-flow nextsteps <WORK-ID> --json`. Refuse `ACTIVE_SUBJECT_MISMATCH`; never use another Story. If it names `singularity-flow wm ensure`, explain that generation may start a repository-reading/file-writing Copilot agent and get explicit consent. Do not start it while waiting. On consent run the exact command, then `singularity-flow next`; otherwise stop. Never derive `--task` from Story text; lifecycle grounding uses the shared repository model.
2. Let CLI synchronization, submission, gate, or approval finish. Before approval run `singularity-flow phase show <phase> --json`, validate reviewer identity/authority, report the automatic phase agent, and require the exact phase name. Every recorded approval must produce its own commit and push.
3. Follow the selected skill. When the selected action is `/sf-code`, do not imitate or inline that skill inside this model-disabled turn: report `Next in Copilot: /sf-code` with the exact phase and stop. The contributor's next invocation owns authoring and publication. For another generative phase, report `/sf-phase` and stop. Never publish from a delegated next-step turn.
4. For a non-delegated publication, run `singularity-flow phase publish <phase> --authored governed-agent --channel copilot-host` once. Confirm sanitized `telemetry/<phase>-gen<N>.json`; use `--usage-json` only for exact usage.
5. On failure run `singularity-flow recover <WORK-ID> --phase <phase> --json`. Relay non-authoring evidence. On `ARTIFACT_AUTHORING_INCOMPLETE`, continue through `/sf-phase` in the same turn: re-author every finding from the governed prompt and retry once only after the artifact fingerprint changes. Never launch nested Copilot. Stop after a second refusal or unchanged fingerprint.
6. Run `singularity-flow phase show <phase> --json`; show the manifest, bounded previews and hash-bound references. Expand source only on request; show binary path/metadata/open instruction.
7. Report action, commit/push, decision authority, agent, telemetry, resolved model, token/cost status, and next action. Do not automatically submit a generation you just published. Show `Next in Copilot: /sf-...`, then `Terminal equivalent: singularity-flow ...`.
8. Obey an approval `Context boundary`. For `new`, tell the contributor to run `/clear` and then `/sf-next`; for `compact`, run `/compact` and then `/sf-next`. After either reset, reapply the Boundary before artifact reads and never start the unlocked phase first.
