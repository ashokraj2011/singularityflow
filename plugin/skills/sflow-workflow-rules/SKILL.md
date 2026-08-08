---
name: sflow-workflow-rules
description: Background rules for Singularity Flow-managed SDLC work. Load when a repository contains singularity/work-items or when the user discusses Singularity Flow phases, approvals, handoffs, or artifact registration.
disable-model-invocation: true
user-invocable: false
---
# Singularity Flow workflow contract

<!-- sflow-output-contract: guided-actions -->
**Output contract:** Use read-only CLI evidence, preserve warnings and ordered actions, and change nothing unless explicitly requested.

`/sf-session` is setup only: stop after its report. Do not inspect artifacts/source or infer delivery work from an ID.

`workflow.json` is immutable-profile lifecycle state; `singularity/workflow.yml` defines new profiles, phases, templates, and authorities. `.github/agents` owns phase defaults, prompt instructions, and added views.

1. Run `singularity-flow status` before changing files and read approved artifacts from earlier phases.
2. Work only on the exact branch stored in `workflow.json`.
3. Do not skip phases or edit lifecycle state files manually.
4. Put each required phase document under `singularity/work-items/<WORK-ID>/artifacts/<phase>/`.
5. Register generated and modified files with `singularity-flow artifact add` or `singularity-flow artifact scan`.
6. Never run `singularity-flow approve` unless the user explicitly invokes the approval skill or directly asks to approve.
7. Never edit `workflow.json`, `STATUS.md`, or approval snapshots by hand.
8. Never store Jira credentials, API tokens, passwords, or secrets in the repository.
9. Treat approved artifacts as durable inputs. Document later deviations in the active phase artifact.
10. End governed-agent generation with `phase publish <phase> --authored governed-agent --channel copilot-host`; it is incomplete until pushed. Run `phase show <phase> --json` and reproduce text documents in full visibly. Shell output does not count; never say “shown above” or substitute a summary.
11. Run `singularity-flow gate` before requesting review. A merge-ready pull request must pass `singularity-flow gate --terminal`.
12. Tag tests with `@ac:AC-n` for every `AC-n` identifier in the requirements artifact.
13. Before reasoning, compose the exact phase/task prompt; if stale, build and recompose identically. Add `--evidence` for verification/review/release.
14. Treat `singularity/work-items/<WORK-ID>/inputs/` and `documents.json` as managed supporting evidence. Upload through `singularity-flow documents upload`, list/view by stable document ID, and never edit the catalog manually.
15. Never choose a workflow template for the user. Use the phase-default agent automatically; change it only when the user explicitly invokes `/sf-agent`. Approval capability comes only from the current human Git/GitHub identity matching a configured authority group.
16. Run `singularity-flow next` only when the user explicitly invokes `/sf-next` or directly asks to execute the next lifecycle action. Execute one action only; approval must retain human-authority validation, exact confirmation, commit, and push.
17. In every final status or next-action handoff, show the direct Copilot command first using `/sf-*`, then show the equivalent `singularity-flow ...` terminal command. Never give a CLI-only next action when a direct Copilot skill can perform it.
