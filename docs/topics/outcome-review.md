---
id: outcome-review
title: Check what a Story delivered
aliases:
  - outcome
  - check-outcome
  - outcome-check
related:
  - run-and-test
  - evidence-matrix
  - app-review
commands:
  - outcome
version: 4
---
Once a Story's code and tests are in, the outcome review puts in one place what a person checks before approval: the application to try, each acceptance criterion with its retained test results, the screens and files a person signs off, and what the Story's end still waits for. Publication of any code-producing phase returns this handoff, including copied, imported, legacy and custom code phases. Opening the review records no acceptance and changes no approval policy.

## Purpose and prerequisites

Use it after a step that writes code has its code and tests, typically before you submit or approve that step, or when a later step reports a criterion as partial. It reads the attached Story, or the one you name, from its committed plan, test receipts, sign-offs and scope decisions, and the application state of this checkout. It needs no network and runs no test.

## Use it from each surface

- **Shell:** `singularity-flow outcome [WORK-ID] [--capability ID] [--json]`.
- **Copilot:** `/sf-code` and `/sf-publish` read the returned outcome once after code publication and hand back to the person. `/sf-outcome [WORK-ID]` reopens that review and its routes; it never starts, signs off or decides anything for you. A failed outcome read preserves the successful publication and its retry route; do not publish again.
- **VS Code:** **Check the Outcome** opens once for each published code generation in the selected Story, using the existing fresh lifecycle snapshot. `singularityFlow.outcomeReview.suggest` is on by default; a personal setting can turn automatic opening off. Cached, invalidated and already-approved targets do not trigger it. Reopening from the Command Palette remains available. Controls are bound to the inspected Story, checkout and generation; refresh after a selection or generation change.

The review links **Workspace Run & Test** for Story-specific configuration, dependencies, application start/stop and test runs. Other buttons open the reference and screenshot, **Capture the running screen** (when the application runs and the repository has its own Playwright; it installs nothing), **Attach a screenshot…**, and **Sign off…**. Sign-off opens the image and asks the existing checklist and reason before recording the person's decision.

## Guided workflow

1. **Try it.** The review lists each declared start entry with its address. When another process already listens there, it says so: stop that process first, or a start is refused.
2. **Check each criterion.** Every acceptance criterion shows its methods, the tests that prove it with their latest outcome, and each visual or inspection check with what it is compared with (a document such as `DOC-001`, a screen or a file).
3. **Look, then sign off.** For a visual check, open the running screen, save a screenshot (the review suggests `<work item>/evidence/<criterion>-<slot>.png` when the plan named none) and compare it with the reference. The sign-off is yours: `singularity-flow decision witness` with the three checklist answers, run by a person who approves the step that delivered the criterion.
4. **Close what the end waits for.** Scope decisions and any blocking evidence findings are listed with their exact commands.
5. **Repair or continue.** **Request a repair** opens the adopted Application Review surface, or prefills the engine's exact repair admission in Copilot for the person to review and send. A published code phase still in progress can open its next generation through `phase begin`, preserving its previous publication; submitted and approved work retain their authorized recovery/return routes. No source edit happens before admission, and opening the prefilled request admits nothing on its own. **Continue workflow** opens the existing submission, review and approval actions. It records no acceptance and approves nothing.

Application Review remains an explicit pinned workflow policy. When adopted, inspect the delivered application now; final **All good** acceptance uses the submitted generation's retained test evidence and stays separate from phase approval. Existing Stories without that policy keep their current visual witnesses and approval rules. A local test rerun, an opened review, or a chat message saying the result looks good cannot manufacture acceptance.

## State and safety

The review is a read. It writes no file, commit or record, and its result names no next action, so an agent never acts on it unasked. Attaching a screenshot only copies your image to the suggested path. A sign-off binds the screenshot's bytes and commits a screenshot kept in the Story's evidence folder together with its record, so nothing is left uncommitted for approval to refuse, and it does not hold a step that is awaiting approval. Keep the file unchanged afterwards. Approval, sign-offs and scope decisions stay with the people who own them.

## Troubleshooting

- *Not running, and another process listens at the address:* that process is from something else, often an old dev server. Stop it, or give this checkout a different personal port in Run & Test.
- *No application is declared:* `singularity-flow app suggest` drafts a start entry from the repository.
- *A visual check says "not done yet" after a screenshot exists:* the sign-off is what records it; a file alone is not proof.

## Related topics

`run-and-test` for start entries and test commands, and `evidence-matrix` for the full per-clause evidence table.
