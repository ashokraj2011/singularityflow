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
version: 6
---
Once a Story's code and tests are in, the outcome review puts in one place what a person checks before approval: the application to try, each acceptance criterion with its retained test results, the screens and files a person signs off, and what the Story's end still waits for. Publication of any code-producing phase returns this handoff, including copied, imported, legacy and custom code phases. Opening the review records no acceptance and changes no approval policy.

## Purpose and prerequisites

Use it after a step that writes code has its code and tests, typically before you submit or approve that step, or when a later step reports a criterion as partial. It reads the attached Story, or the one you name, from its committed plan, test receipts, sign-offs and scope decisions, and the application state of this checkout. It needs no network and runs no test.

## Use it from each surface

- **Shell:** `singularity-flow outcome [WORK-ID] [--capability ID] [--json]`.
- **Copilot:** `/sf-code`, `/sf-phase` and `/sf-publish` read the returned outcome once after code publication and ask what you want to validate next. The native `sflowDeliveryValidation` tool shows SFlow's current choices; without it Copilot asks in chat. Choose tests, application setup/start, evidence review, repair or continuation. Only your selected action opens. `/sf-outcome [WORK-ID]` reopens the same question; cancel it to leave everything unchanged. A failed outcome read preserves the successful publication and its retry route; do not publish again.
- **VS Code:** **Check the Outcome** opens once for each published code generation in the selected Story, using the existing fresh lifecycle snapshot. `singularityFlow.outcomeReview.suggest` is on by default; a personal setting can turn automatic opening off. Cached, invalidated and already-approved targets do not trigger it. Reopening from the Command Palette remains available. Controls are bound to the inspected Story, checkout and generation; refresh after a selection or generation change.

The review links **Workspace Run & Test** for Story-specific configuration, dependencies, application start/stop and test runs. Other buttons open the reference and screenshot, **Capture the running screen** (when the application runs and the repository has its own Playwright; it installs nothing), **Attach a screenshot…**, and **Sign off…**. Sign-off opens the image and asks the existing checklist and reason before recording the person's decision.

The question and progress steps come from `data.outcome.validation`, the same versioned contract in CLI, Copilot and VS Code. **Validate Story Delivery** in the Command Palette asks the question again on demand. It binds choices to the inspected Story, capability, checkout and generation, and refuses a changed selection. An explicit `--capability` selection stays the same when Copilot opens the native question. One question opens per invocation; cancellation never causes an automatic retry, and a duplicate tool invocation cannot replace the question already open. Retained test command results and diagnostic runs are reported separately. An old generation's pass cannot verify the current delivery.

## Guided workflow

1. **Choose a check.** Run the Story's configured tests, set up or start the application, review acceptance evidence, request repair, or continue with the existing workflow. For a backend or command-line tool, validate its API or executable behavior; no web screen or screenshot is invented. A missing launch configuration offers setup and does not create a new Story gate.
2. **Try it.** The review lists each declared start entry with its address. Select Start to launch it in this Story's checkout, or Open when it is ready. When another process already listens there, it says so: review your configuration or stop that process yourself. **Set up or change local run configuration** opens a personal checkout profile for launch commands, dependencies and environment file names. Saving it does not change shared tests or workflow policy and does not start the application. Secret values stay in your local binding tools.
3. **Check each criterion.** Every acceptance criterion shows its methods, its test witnesses and each visual or inspection check with what it is compared with (a document such as `DOC-001`, a screen or a file). Overall passing test counts do not establish clause acceptance. From Verification, Release or another document phase, **Run tests** explicitly targets the preceding code phase that owns the runner, and records only a local run. It does not reopen or republish that earlier phase. A Story with no code delivery offers no test action.
4. **Look, then sign off.** For a visual check, open the running screen, save a screenshot (the review suggests `<work item>/evidence/<criterion>-<slot>.png` when the plan named none) and compare it with the reference. The sign-off is yours: use the native human evidence checklist or `singularity-flow decision witness`, run by a person who approves the step that delivered the criterion. A required screenshot found missing during authoring offers application setup/capture or your own upload before publication.
5. **Close what the end waits for.** Scope decisions and any blocking evidence findings are listed with their exact commands.
6. **Repair or continue.** **Request a repair** opens the adopted Application Review surface, or prefills the engine's exact repair admission in Copilot for the person to review and send. A published code phase still in progress can open its next generation through `phase begin`, preserving its previous publication; submitted and approved work retain their authorized recovery/return routes. No source edit happens before admission, and opening the prefilled request admits nothing on its own. **Continue workflow** opens the existing submission, review and approval actions. It waives no outstanding checks, records no acceptance and approves nothing.

Application Review remains an explicit pinned workflow policy. When adopted, inspect the delivered application now; final **All good** acceptance uses the submitted generation's retained test evidence and stays separate from phase approval. Existing Stories without that policy keep their current visual witnesses and approval rules. A local test rerun, an opened review, or a chat message saying the result looks good cannot manufacture acceptance.

## State and safety

The review is a read. It writes no file, commit or record, and its result names no next action, so an agent never acts on it unasked. Attaching a screenshot only copies your image to the suggested path. A sign-off binds the screenshot's bytes and commits a screenshot kept in the Story's evidence folder together with its record, so nothing is left uncommitted for approval to refuse, and it does not hold a step that is awaiting approval. Keep the file unchanged afterwards. Approval, sign-offs and scope decisions stay with the people who own them.

## Troubleshooting

- *Not running, and another process listens at the address:* that process is from something else, often an old dev server. Stop it, or give this checkout a different personal port in Run & Test.
- *No application is declared:* choose **Set up or change local run configuration**, or use `/sf-run-app suggest`. The CLI issues an exact private draft; after preview and your confirmation, `app config save-local --application-file <issued-file>` saves it for this checkout without a shared configuration proposal.
- *A visual check says "not done yet" after a screenshot exists:* the sign-off is what records it; a file alone is not proof.
- *An action asks you to refresh:* **Refresh** first renews the shared Story snapshot, then reads the outcome. Actions stay disabled during that refresh. A snapshot failure shows its original error; the panel does not poll or use a stale result to run or sign off anything.

## Related topics

`run-and-test` for start entries and test commands, and `evidence-matrix` for the full per-clause evidence table.
