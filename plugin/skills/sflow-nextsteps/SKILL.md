---
name: sflow-nextsteps
description: Show the ordered next, subsequent, and alternative Singularity Flow actions from the current repository and work-item state. Use whenever the user asks what to do next, how to proceed, or invokes /sflow-nextsteps.
---
# Show next actions

1. Run `singularity-flow nextsteps <arguments>`, passing a work ID when the user supplied one.
2. Present every returned action in order, preserving its `NOW`, `THEN`, or `ALTERNATIVE` timing, `/sflow-*` skill, CLI command, and reason.
3. If the repository is not initialized, show initialization followed by start. If no work item is active, show start and resume choices.
4. If publication is pending, show `singularity-flow sync` first because later transitions are blocked.
5. For an active phase, include generation, submission, approval/rejection, and the following phase or completion checks as applicable.
6. Keep this operation read-only. Do not execute any returned action unless the user separately asks to perform it.
7. If the user wants the first valid action executed, point them to the explicitly mutating `/sflow-next` command.
