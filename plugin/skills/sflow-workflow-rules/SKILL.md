---
name: sflow-workflow-rules
description: Background rules for Singularity Flow-managed SDLC work. Load when a repository contains singularity/work-items or when the user discusses Singularity Flow phases, approvals, handoffs, or artifact registration.
user-invocable: false
---
# Singularity Flow workflow contract

When `singularity/work-items/<WORK-ID>/workflow.json` exists, it is the immutable-profile lifecycle state; `singularity/workflow.yml` defines new work types, phases, personas, templates, and approvals.

1. Run `singularity-flow status` before changing files and read approved artifacts from earlier phases.
2. Work only on the exact branch stored in `workflow.json`.
3. Do not skip phases or edit lifecycle state files manually.
4. Put each required phase document under `singularity/work-items/<WORK-ID>/artifacts/<phase>/`.
5. Register generated and modified files with `singularity-flow artifact add` or `singularity-flow artifact scan`.
6. Never run `singularity-flow approve` unless the user explicitly invokes the approval skill or directly asks to approve.
7. Never edit `workflow.json`, `STATUS.md`, or approval snapshots by hand.
8. Never store Jira credentials, API tokens, passwords, or secrets in the repository.
9. Treat approved artifacts as durable inputs. Document later deviations in the active phase artifact.
10. End every successful artifact generation with `singularity-flow phase publish <phase>`; generation is incomplete until its commit is pushed. Then run `singularity-flow phase show <phase> --json` and reproduce every returned text document in full in the visible assistant response. A collapsible Shell/tool block does not count as review. Never say the documents were “shown above” and never replace them with a summary.
11. Run `singularity-flow gate` before requesting review. A merge-ready pull request must pass `singularity-flow gate --terminal`.
12. Tag tests with `@ac:AC-n` for every `AC-n` identifier in the requirements artifact.
13. Before phase reasoning, run `singularity-flow wm compose --phase <phase> --task "<current objective>"` and use the complete returned prompt. If missing or stale, build with the same phase and exact task text, then compose again. Add `--evidence` for verification, review, or release decisions.
14. Treat `singularity/work-items/<WORK-ID>/inputs/` and `documents.json` as managed supporting evidence. Upload through `singularity-flow documents upload`, list/view by stable document ID, and never edit the catalog manually.
15. Never choose a workflow template or persona for the user. Anyone may choose any persona; phase mappings are recommendations, while approval capability comes from persona configuration.
16. Run `singularity-flow next` only when the user explicitly invokes `/sflow-next` or directly asks to execute the next lifecycle action. Execute one action only; approval must retain persona selection, confirmation, commit, and push.
