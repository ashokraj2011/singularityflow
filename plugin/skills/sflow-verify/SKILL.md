---
name: sflow-verify
description: Verify implementation against acceptance criteria, run checks, capture evidence, and register the Singularity Flow verification artifact.
disable-model-invocation: true
argument-hint: "[test scope or environment]"

---
# Verification phase

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use the complete governed prompt and approved inputs, ask unresolved questions, then publish and show configured artifacts.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

1. Run `singularity-flow verify --json` first. It resolves the subject, phase, generation, pending publication and approval state, and returns the milestone, the checkpoint, and the underlying kernel operations. If the checkpoint is `recovery` or `approval`, stop there and relay it — those are human boundaries. Otherwise continue with the authoring below, which publishes through the same kernel operation the phase command uses.
1. Run `singularity-flow status --json`; stop if the current phase is not `verification`. Use that governed workflow as Story context.
2. Run `singularity-flow wm compose --phase verification --evidence` and use the complete returned prompt. If the grounding plan is missing or stale, show and run the exact returned ensure command only with explicit contributor authorization, then rerun the identical compose command. Never add the Story title or a conversational verification scope as `--task`. Use the shared testing, development, security, and evidence grounding.
3. Read approved requirements, design, implementation summary, and selected source evidence.
4. Map each acceptance criterion to executable or inspectable evidence and its `@ac:AC-n` test tag.
5. Run relevant tests and add missing tests when needed. Record exact commands and results.
6. Cover regression, negative cases, boundaries, failure modes, security, reliability, accessibility, and performance where applicable.
7. Run `singularity-flow prepare verification`, complete the evidence without unobserved claims, and fill `Agent brief` with the verdict, material failures or omissions, residual risk, and release recommendation. Remove placeholders, then run `singularity-flow phase publish verification --authored governed-agent --channel copilot-host`.
8. Run `singularity-flow phase show verification --json`, then reproduce every published text document in full in the visible assistant response between `--- BEGIN <path> ---` and `--- END <path> ---`, with its ID, kind, byte count, and hash. A collapsible Shell/tool block does not count. Never say “shown above.” Never replace it with a summary. For binary documents, show the absolute path, metadata, and open instruction.
9. Do not submit or approve automatically. End the handoff with the direct Copilot action first, followed by its terminal equivalent:
   - `Next in Copilot: /sf-submit verification`
   - `Terminal equivalent: singularity-flow submit verification`
