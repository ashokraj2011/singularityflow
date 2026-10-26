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
commands:
  - outcome
version: 3
---
Once a Story's code and tests are in, the outcome review puts in one place what a person wants to see before deciding anything: the application to try, each acceptance criterion with the tests that prove it, the screens and files a person signs off, and what the Story's end still waits for. It is optional. It records nothing, no step waits for it, and every route it shows is a command that already exists.

## Purpose and prerequisites

Use it after a step that writes code has its code and tests, typically before you submit or approve that step, or when a later step reports a criterion as partial. It reads the attached Story, or the one you name, from its committed plan, test receipts, sign-offs and scope decisions, and the application state of this checkout. It needs no network and runs no test.

## Use it from each surface

- **Shell:** `singularity-flow outcome [WORK-ID] [--capability ID] [--json]`.
- **Copilot:** `/sf-outcome [WORK-ID]` shows the same review and the routes; it never starts, signs off or decides anything for you.
- **VS Code:** run **Singularity Flow: Check the Outcome** from the Command Palette. Its buttons start the application, run the tests, open the reference and the screenshot, **Capture the running screen** (when the application runs and the repository has its own Playwright; it runs as a task you can watch, in a trusted workspace, and installs nothing), **Attach a screenshot…** to the suggested path, and **Sign off…**: it opens the screenshot, asks the three checklist questions and what you looked at, and records the sign-off after you confirm. To be offered the review once when a step is submitted for approval, turn on the setting `singularityFlow.outcomeReview.suggest` (off by default).

## Guided workflow

1. **Try it.** The review lists each declared start entry with its address. When another process already listens there, it says so: stop that process first, or a start is refused.
2. **Check each criterion.** Every acceptance criterion shows its methods, the tests that prove it with their latest outcome, and each visual or inspection check with what it is compared with (a document such as `DOC-001`, a screen or a file).
3. **Look, then sign off.** For a visual check, open the running screen, save a screenshot (the review suggests `<work item>/evidence/<criterion>-<slot>.png` when the plan named none) and compare it with the reference. The sign-off is yours: `singularity-flow decision witness` with the three checklist answers, run by a person who approves the step that delivered the criterion.
4. **Close what the end waits for.** Scope decisions and any blocking evidence findings are listed with their exact commands.

## State and safety

The review is a read. It writes no file, commit or record, and its result names no next action, so an agent never acts on it unasked. Attaching a screenshot only copies your image to the suggested path. A sign-off binds the screenshot's bytes and commits a screenshot kept in the Story's evidence folder together with its record, so nothing is left uncommitted for approval to refuse, and it does not hold a step that is awaiting approval. Keep the file unchanged afterwards. Approval, sign-offs and scope decisions stay with the people who own them.

## Troubleshooting

- *Not running, and another process listens at the address:* that process is from something else, often an old dev server. Stop it, or give this checkout a different personal port in Run & Test.
- *No application is declared:* `singularity-flow app suggest` drafts a start entry from the repository.
- *A visual check says "not done yet" after a screenshot exists:* the sign-off is what records it; a file alone is not proof.

## Related topics

`run-and-test` for start entries and test commands, and `evidence-matrix` for the full per-clause evidence table.
