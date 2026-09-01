---
name: sflow-auto
description: Plan, ratify, and control one bounded Singularity Flow Auto flight.
disable-model-invocation: true
argument-hint: "<requirement> | --goal <GOAL-ID> | plan <requirement> | adopt --from-adhoc <AHS-ID> | start <PLAN-ID> | list | continue <STORY-ID> | status|report|needs-you|repair|respond|switch-unit|pause|stop|takeover|resume|discard <FLIGHT-ID>"

---
# Run bounded Auto work

<!-- sflow-output-contract: explicit-selection -->
**Output contract:** Collect every required choice explicitly; never infer or preselect; preserve errors, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → verified `repositoryPath`, cwd=`repositoryPath`; never `$HOME`; no active Story is required.

1. Use the verified workspace cwd. Never search `$HOME` or infer a repository from chat. With no argument, show the forms and change nothing.
2. Plan with `singularity-flow auto plan "<REQUIREMENT>" --json`, its shorthand, or `singularity-flow auto --goal <GOL-ID|GEX-ID> --json`. Goal input stays exact and needs separate ratification. Planning creates no Story or authority. Show the complete Plan and complete ratification-packet SHA-256.
3. Read with `singularity-flow auto show-plan <PLAN-ID> --json`, `auto list --json`, `auto status|report|needs-you <FLIGHT-ID> --json`, or `auto continue <STORY-ID> --json`. Continue only proposes. `auto adopt --from-adhoc <AHS-ID> --json` stays non-startable and retains `pre-auto-adhoc`/`discovered-at-landing` provenance.
4. Start only after the user types the full packet hash: `singularity-flow auto start --plan <PLAN-ID> --confirm <PACKET-SHA256> --json`. Never extract or prefill confirmation.
5. Preview repair with `singularity-flow auto repair <FLIGHT-ID> --refusal <REFUSAL-ID> --json`. Show scope, evidence, parent, and hash. Run its confirmed command once only after the user types that hash; a second failure halts.
6. Show typed requests first. Record exactly one explicit response with `singularity-flow auto respond <FLIGHT-ID> --request <REQUEST-ID> --choice <ID> --confirm <REQUEST-SHA256> --json`; use `--answer <TEXT>` for clarification or `--broker-reference <REFERENCE>` for credentials. Never collect credential values. Responding does not resume.
7. Preview `auto switch-unit <FLIGHT-ID> --execution-unit <ID> --reason "<TEXT>" --json`; apply only its exact-hash command. It links a new attempt without changing the Task Contract.
8. Control with `auto pause|takeover|stop <FLIGHT-ID> --confirm <CHECKPOINT-SHA256> --json` only after displaying the complete checkpoint SHA-256. Resume uses `auto resume <FLIGHT-ID> --confirm <CHECKPOINT-SHA256> --json`; open requests block it. Before discard, require the user to type the exact flight ID as confirmation, then run `auto discard <FLIGHT-ID> --confirm <FLIGHT-ID> --json`. `halt` remains a stop alias.
9. Never invoke `auto flight-step` directly, decide an approval/request, waive policy, expand scope, merge, deploy, or infer a hash. Stop on stale authority or failure. Report references, Git outcome, checkpoint, and exact next command.
