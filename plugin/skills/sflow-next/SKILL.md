---
name: sflow-next
description: Execute the single next valid Singularity Flow action, including grounded phase generation, submission, interactive approval, publication recovery, or final governance.
argument-hint: "[task focus]"
disable-model-invocation: true
---
# Execute the next workflow action

This is an explicitly invoked mutating command. Execute one lifecycle action, report its durable Git result, and stop. Never loop through multiple approvals or silently choose an approval persona.

1. Run `singularity-flow nextsteps --json` to show the state and prerequisites, then run `singularity-flow next --task "<current objective>"`.
2. If the CLI synchronizes, submits, runs the terminal gate, or opens approval, let that action finish. Submission prints every generated phase document before recommending approval. Before an approval action, run `singularity-flow phase show <phase>` and present those documents; never reduce review to filenames or a summary. Approval must retain interactive persona selection and explicit phase confirmation: keep the command in a persistent interactive shell, mirror its displayed persona menu through `ask_user`, and send the selected menu number back with `write_bash`. Never select a persona automatically. Require the reviewer to type the exact phase name afterward. Every recorded approval must produce its own commit and push before success.
3. If the CLI reports `Next step prepared`, use the composed grounding printed by the command, inspect the prepared artifact and approved inputs, and complete exactly the active phase contract. Follow the same scope, traceability, evidence, test, and placeholder rules as `/sflow-phase`.
4. After authoring, run relevant validation and `singularity-flow phase publish <phase>`. Include `--usage-json <file>` only when exact provider/model usage is available.
5. Preserve the command's post-publication document display: show every published text document in full with its path and hash. For a binary document, show its path and open instruction. Never replace the published document with a summary.
6. Report the executed action, commit, push destination, persona when applicable, token status, and the next valid action. Do not automatically submit a generation you just published; the next `/sflow-next` invocation handles that separate lifecycle action.
