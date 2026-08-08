---
name: sflow-next
description: Execute the single next valid Singularity Flow action, including grounded phase generation, submission, interactive approval, publication recovery, or final governance.
disable-model-invocation: true
argument-hint: "[task focus]"

---
# Execute the next workflow action

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.

Execute one lifecycle action, report its durable Git result, and stop. Never loop through approvals. The phase contract selects the agent; human identity grants approval authority.

1. Run `singularity-flow nextsteps --json` to show state and prerequisites. If it names `singularity-flow wm build`, explain that semantic generation starts a repository-reading, file-writing Copilot agent and ask for explicit consent. Do not start it while waiting. After consent, run `singularity-flow next --yes --task "<current objective>"`; after a decline, stop with no state change. Otherwise run `singularity-flow next --task "<current objective>"`.
2. If the CLI synchronizes, submits, runs the terminal gate, or opens approval, let that action finish. Before approval, run `singularity-flow phase show <phase> --json` and use the visible artifact review protocol below. Validate the real reviewer identity and authority group, report the automatic phase agent, and require the reviewer to type the exact phase name. Every recorded approval must produce its own commit and push.
3. If `Next step prepared`, use its composed grounding and approved inputs. At **Human clarification checkpoint**, use `ask_user` and wait; a `required` checkpoint always pauses. Without `ask_user`, show questions and stop before authoring or publication. Then follow `/sf-phase` scope, traceability, tests, and placeholder rules.
4. Validate and run `singularity-flow phase publish <phase> --authored governed-agent --channel copilot-host`. Confirm sanitized `telemetry/<phase>-gen<N>.json`; use `--usage-json` only for exact external usage. A current-response record may be pending until the next submit reconciles it.
5. After any publish or submit action, run `singularity-flow phase show <phase> --json`. In the visible assistant response, reproduce every published text document in full between `--- BEGIN <path> ---` and `--- END <path> ---`, preceded by its stable ID, kind, byte count, and SHA-256. A Shell/tool block, even when it contains the text, is collapsible and does not satisfy artifact review. Never say “shown above,” “rendered above,” or “documents shown,” and never replace the published document with a summary. For a binary document, show its absolute path, metadata, and open instruction.
6. Report action, commit/push, actor/authority for decisions, agent, telemetry, resolved model, token/cost status, and next action. Do not automatically submit a generation you just published.
7. If an approval prints a `Context boundary`, obey it and stop. For `new`, tell the contributor to run `/clear` and then `/sf-next`; for `compact`, tell them to run `/compact` and then `/sf-next`. Never start the newly unlocked phase before the requested boundary.
8. On failure, run `singularity-flow logs --level error --tail 40` and relay message, command, and exit code before retrying.
