---
id: story-lifecycle
title: Story lifecycle, phases, and generations
aliases: [phases, generations, workflow-state]
commands: [status, finalize, cancel, reopen]
related: [starting-work, sequence-gates, pins]
---
A story moves through the phases of its pinned work type (e.g. requirements → design → implementation → verification). Each phase produces artifacts as numbered generations; a rejection requires a fresh generation — history is never rewritten. State lives in `singularity/work-items/<ID>/` on the story branch: workflow.json (authority), artifacts, approvals, context, telemetry, evidence.

`sflow status` shows current phase, generation, and approvals. `finalize` completes a story after its checks; `cancel --reason` closes it honestly with everything preserved as reconstructable history; `reopen` brings completed work back under governance instead of editing it in the dark.
