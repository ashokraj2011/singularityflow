---
name: sflow-workflow-rules
description: Background rules for Singularity Flow-managed SDLC work. Load when a repository contains .singularity/work-items or when the user discusses Singularity Flow phases, approvals, handoffs, or artifact registration.
user-invocable: false
---
# Singularity Flow workflow contract

When `.singularity/work-items/<WORK-ID>/workflow.json` exists, it is the immutable-profile lifecycle state; `.singularity/workflow.yml` defines new work types, phases, personas, templates, and approvals.

1. Run `singularity-flow status` before changing files and read approved artifacts from earlier phases.
2. Work only on the exact branch stored in `workflow.json`.
3. Do not skip phases or edit lifecycle state files manually.
4. Put each required phase document under `.singularity/work-items/<WORK-ID>/artifacts/<phase>/`.
5. Register generated and modified files with `singularity-flow artifact add` or `singularity-flow artifact scan`.
6. Never run `singularity-flow approve` unless the user explicitly invokes the approval skill or directly asks to approve.
7. Never edit `workflow.json`, `STATUS.md`, or approval snapshots by hand.
8. Never store Jira credentials, API tokens, passwords, or secrets in the repository.
9. Treat approved artifacts as durable inputs. Document later deviations in the active phase artifact.
10. End every successful artifact generation with `singularity-flow phase publish <phase>`; generation is incomplete until its commit is pushed.
11. Run `singularity-flow gate` before requesting review. A merge-ready pull request must pass `singularity-flow gate --terminal`.
12. Tag tests with `@ac:AC-n` for every `AC-n` identifier in the requirements artifact.
13. Before phase reasoning, load `singularity-flow wm context <phase> --task "<current objective>" --concat`; rebuild the phase model when missing or stale. Load evidence only for verification, review, or release decisions.
14. Treat `.singularity/work-items/<WORK-ID>/inputs/` and `documents.json` as managed supporting evidence. Upload through `singularity-flow documents upload`, list/view by stable document ID, and never edit the catalog manually.
14. Never choose a work type or persona for the user. Anyone may choose any persona; phase mappings are recommendations, while approval capability comes from persona configuration.
