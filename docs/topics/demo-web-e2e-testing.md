---
id: demo-web-e2e-testing
title: Demo Web E2E Testing starter
aliases: [demo-web-testing, screenshot-repair-loop]
questions:
  - How do I test and repair a web app against a screenshot?
  - Which custom agents and skills ship with the demo web workflow?
commands: [workflow, start, documents, prepare, phase, submit, approve, decision, mcp]
related: [document-test-repair, workflow-authoring, workflow-decisions, story-lifecycle, approvals]
version: 1
---

Select **Demo Web E2E Testing** (`demo-web-e2e-testing`) during Story intake. Full starter
initialization includes it. For a minimal or earlier repository, review/adopt it through the
starter catalog or `singularity-flow workflow install demo-web-e2e-testing` using the existing
configuration-authority proposal flow. It adds private phases, three custom agents and three
library skills; it does not modify other workflows or existing Stories. Duplicate the seed to
customize it. Reinstalling preserves repository-owned agent and skill overrides.

| Phase | Custom agent | Attached custom skill | Canonical Copilot route |
|---|---|---|---|
| Screenshot and web scenario intake | demo-web-analyst | demo-web-screenshot-intake | `/sf-document-intake` |
| Check current web application | demo-web-tester | demo-web-screenshot-check | `/sf-scenario-check` |
| Repair web code and regression tests | demo-web-developer | demo-web-defect-repair | `/sf-code` |
| Retest web behavior and accept | demo-web-tester | demo-web-screenshot-check | `/sf-scenario-check` |

The custom skills are prompt instructions in `singularity/skill-library/<id>/SKILL.md`, attached
through `attachments.yml`. They are not new slash commands or compiled executable SKP packages.
The canonical skills retain pause/session resolution, publication and human approval boundaries.
Story snapshots pin the exact agent and skill bytes; workflow export/import carries these dependencies.

## Run the demo

1. Start a Story with this work type and upload the expected screenshot with `/sf-upload`.
   No sample image is fabricated or assumed. Confirm the route/UI state, local/test origin,
   browser/viewport, stable data, visual tolerance, interaction expectations and allowed repair paths.
2. Inspect the repository's real test setup. Select existing Playwright tests, Playwright MCP or
   another approved E2E runner. Configure exact test commands/report adapters through `/sf-test-setup`.
   MCP browser use additionally needs host setup, authorized tools and a live smoke check. The seed
   allows the existing `playwright` host only for this demo tester in check/retest, without
   changing any existing agent's browser permissions.
   It does not install Playwright, launch an app, grant production access or invent a passing receipt.
3. Approve intake, then let the tester check **existing** code first. The report retains reference
   and fresh observed screenshot hashes, scenario results, actual commands and tested revision.
   Visual inspection is labelled honestly; exact image-diff assertions require a real diff runner.
4. Submit the report with its agent verdict (`--decision verdict=pass`, `repair` or `blocked`) and
   request human review. A pass may finish without edits only with the human's implementation-
   applicability decision. A failure report approved by a human authorizes repair, not acceptance.
5. For repair, the developer changes scoped web code/tests through `/sf-code`, retains structured
   test receipts and hands off to the separate tester. Fresh retest plus human acceptance can finish;
   otherwise route back to repair or restore blocked access. References/tolerances are not softened.

Each decision allows two automatic backward routes before pausing for explicit human direction.
The human can review another permitted attempt, revise intake or cancel; a failed/blocked verdict
cannot take the Finish route. A screenshot is not proof of interactions or exact test execution.

Use `singularity-flow workflow simulate demo-web-e2e-testing --json` (Copilot: `/sf-workflows
simulate demo-web-e2e-testing --json`) to inspect the structural lifecycle. Simulation runs no app,
browser or tests and does not grant approval.
