# {{work.id}} — Publication and PR review

## Publication boundary

{{inputs}}

<!-- sflow:guidance Record the configured remote, selected base branch and pinned base commit, isolated Story branch, current Story commit/tree, and exact destination ref. The destination must be the Story ref; never write or force-update the selected base. State whether the branch is already published or has a pending-publication recovery record. -->

TODO: Record the remote, base branch and pinned base commit, Story branch, current Story commit and tree, and the exact destination ref.

## Change and coverage summary

<!-- sflow:guidance Summarize changed Page Objects, specs, fixtures, helpers, and configuration. Map the proposed PR to approved `[POC:AC-nnn]` items and the regression footprint. Include an exact diff/stat and identify any non-test source change for special review. -->

TODO: Summarize the changed files and map the proposed PR to the approved acceptance items.

## Validation evidence

<!-- sflow:guidance Link the approved validation generation, commands, exit codes, scenario matrix, Playwright reports, traces, screenshots, logs, and governed MCP provenance. Do not describe failed, stale, blocked, or not-run evidence as green. -->

TODO: Link the approved validation generation, its commands and exit codes, the scenario matrix, and the reports, traces, screenshots and logs it retained.

## Residual risk and rollback

<!-- sflow:guidance Document uncovered journeys/browsers/viewports, flake risk, environment limitations, test-data effects, follow-up work, and how reviewers can revert or disable the added tests safely. -->

TODO: List the residual risks and how reviewers can revert or disable the added tests.

## Human decision

<!-- sflow:guidance Prepare a proposed PR title, description, coverage summary, reviewer checklist, base ref, and head ref. This artifact **does not create a pull request**. Record the independent quality and engineering decisions required by policy. Only after both approvals may a contributor explicitly invoke the governed publication/PR action; a refusal or rejection routes back to the named phase. -->

TODO: Prepare the proposed PR title, description, reviewer checklist, base ref and head ref for the reviewers' decision.
