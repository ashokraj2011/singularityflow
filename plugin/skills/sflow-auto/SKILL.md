---
name: sflow-auto
description: Plan, ratify, inspect, and control one bounded Singularity Flow Auto flight.
disable-model-invocation: true
argument-hint: "plan <requirement> [--until <phase>] | plan --story <STORY-ID> | --goal <GOAL-ID> | adopt --from-adhoc <AHS-ID> | start <PLAN-ID> | list | continue <STORY-ID> | status|report|needs-you|repair|respond|switch-unit|pause|stop|takeover|resume|discard <FLIGHT-ID>"

---
# Run bounded Auto work

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Use Boundary cwd. With no argument, show forms; change nothing.
2. Plan with `singularity-flow auto plan "<REQUIREMENT>" [--until <PHASE>] --json` or `singularity-flow auto --goal <GOL-ID|GEX-ID> --json`. A bare endpoint must be on the selected rail. Require an approved delivery capability: show one eligible result, ask among returned IDs, or relay `CAPABILITY_REGISTRATION_REQUIRED`. Never invent one. Show the complete Plan, four-word Story/branch identity, collision suffix, and complete ratification-packet SHA-256; planning creates no authority.
3. Inspect model-free with `singularity-flow auto plan --story <STORY-ID> --json`; do not combine new-work inputs. Other reads are `singularity-flow auto show-plan`, `singularity-flow auto list`, `singularity-flow auto status|report|needs-you`, and `singularity-flow auto continue`, with IDs and `--json`. `singularity-flow auto adopt --from-adhoc <AHS-ID>` stays non-startable and retains provenance.
4. Start after the user types the full packet hash: `singularity-flow auto start --plan <PLAN-ID> --confirm <PACKET-SHA256> --json`. Never extract or prefill confirmation.
5. Preview `auto repair <FLIGHT-ID> --refusal <REFUSAL-ID> --json`; show objective, scope, evidence, parent, budget, eligibility, and hash. Under default `ask`, confirm only after the user types that hash. Ratified `auto-on-machine-actionable` permits one repair only for an unchanged Candidate with deterministic failed verification. Provider, timeout, scope, protected-path, credential, or judgment failures stop; a second failure halts.
6. Show each Human Request and its options. Record a response using `auto respond <FLIGHT-ID> --request <REQUEST-ID> --choice <ID> --confirm <REQUEST-SHA256> --json`; use permitted `--answer` text or `--broker-reference` for credentials. Never collect credential values. A response neither approves, waives, nor resumes.
7. Preview `auto switch-unit <FLIGHT-ID> --execution-unit <ID> --reason "<TEXT>" --json`; apply only its exact-hash command. It links a new attempt, not a new Task Contract.
8. After showing the complete checkpoint SHA-256, control with `auto pause|takeover|stop <FLIGHT-ID> --confirm <HASH> --json`; resume uses `auto resume <FLIGHT-ID> --confirm <HASH> --json` and open requests block it. Discard requires the user to type the exact flight ID as confirmation; `halt` aliases stop.
9. Reports show contracts, execution events, Candidate, lineage, quality floor, and separately assured prompt/input/output/tool-output economics. Never invoke `auto flight-step` directly. Never infer tokens, expose prompts, rank people, waive authority, expand scope, merge, deploy, or infer a hash. On failure, report references, Git outcome, checkpoint, and one exact next command.
