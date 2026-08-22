---
name: sflow-next
description: Execute the single next valid Singularity Flow action, including grounded phase generation, submission, interactive approval, publication recovery, or final governance.
disable-model-invocation: true

---
# Execute the next workflow action

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.

Execute one lifecycle action, report its durable Git result, and stop. Never loop through approvals. The phase contract selects the agent; human identity grants approval authority.

1. Run `singularity-flow nextsteps --json`. If it names `singularity-flow wm ensure`, explain that generation may start a repository-reading, file-writing Copilot agent and ask for explicit consent. Do not start it while waiting. On consent, run the exact command, then `singularity-flow next`; on decline, stop. Otherwise run `singularity-flow next`. Never turn a Story title or conversational paraphrase into `--task`: lifecycle grounding reuses the shared repository model across Stories.
2. Let CLI synchronization, submission, terminal gate, or approval finish. Before approval, run `singularity-flow phase show <phase> --json`. Validate reviewer identity and authority, report the automatic phase agent, and require the exact phase name. Every recorded approval must produce its own commit and push.
3. If `Next step prepared`, use its composed grounding and approved inputs. At **Human clarification checkpoint**, use `ask_user` and wait; `required` always pauses. Record answers with `singularity-flow clarification record <phase> --response-file <file>`. Without questions or a valid record, stop before authoring or publication. Then follow `/sf-phase`.
4. Validate and run `singularity-flow phase publish <phase> --authored governed-agent --channel copilot-host`. Confirm sanitized `telemetry/<phase>-gen<N>.json`; use `--usage-json` only for exact external usage. A current-response record may be pending until the next submit reconciles it.
5. Run `singularity-flow phase show <phase> --json`. Reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, preceded by stable ID, kind, bytes, and SHA-256. A Shell/tool block does not count. Never say “shown above.” Never replace the published document with a summary. For binary documents, show path, metadata, and open instruction.
6. Report action, commit/push, actor/authority for decisions, agent, telemetry, resolved model, token/cost status, and next action. Do not automatically submit a generation you just published. Show the next direct Copilot action first as `Next in Copilot: /sf-...`, then its exact CLI form as `Terminal equivalent: singularity-flow ...`.
7. If an approval prints a `Context boundary`, obey it and stop. For `new`, tell the contributor to run `/clear` and then `/sf-next`; for `compact`, tell them to run `/compact` and then `/sf-next`. Never start the newly unlocked phase before the requested boundary.
8. On failure, run `singularity-flow logs --level error --tail 40` and relay message, command, and exit code before retrying.
