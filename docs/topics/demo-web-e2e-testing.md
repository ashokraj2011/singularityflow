---
id: demo-web-e2e-testing
title: Demo Web E2E Testing starter
aliases: [demo-web-testing, screenshot-repair-loop]
questions:
  - How do I test and repair a web app against a screenshot?
  - Which custom agents and skills ship with the demo web workflow?
commands: [workflow, start, documents, prepare, phase, submit, approve, decision, mcp]
related: [document-test-repair, workflow-authoring, workflow-decisions, story-lifecycle, approvals]
version: 2
---

Select **Demo Web E2E Testing** (`demo-web-e2e-testing`) during Story intake to check a web
application against an expected screenshot, repair it if needed and retest it. It adds private
phases, three custom agents and three library skills; it does not modify other workflows or
existing Stories.

## Purpose and prerequisites

Use this starter when a Story's expected result is a screenshot of a web page and the team wants
the existing code checked before any repair.

- **The starter.** Full starter initialization includes it. For a minimal or earlier repository,
  review/adopt it through the starter catalog or
  `singularity-flow workflow install demo-web-e2e-testing` using the existing
  configuration-authority proposal flow. Duplicate the seed to customize it. Reinstalling preserves
  repository-owned agent and skill overrides.
- **A real expected screenshot.** You upload it. No sample image is fabricated or assumed.
- **A real test setup.** Existing Playwright tests, Playwright MCP or another approved E2E runner,
  with exact test commands and report adapters. MCP browser use additionally needs host setup,
  authorized tools and a live smoke check.
- **What it does not do.** It does not install Playwright, launch an app, grant production access
  or invent a passing receipt.

### Phases, agents and skills

| Phase | Custom agent | Attached custom skill | Canonical Copilot route |
|---|---|---|---|
| Screenshot and web scenario intake | demo-web-analyst | demo-web-screenshot-intake | `/sf-document-intake` |
| Check current web application | demo-web-tester | demo-web-screenshot-check | `/sf-scenario-check` |
| Repair web code and regression tests | demo-web-developer | demo-web-defect-repair | `/sf-code` |
| Retest web behavior and accept | demo-web-tester | demo-web-screenshot-check | `/sf-scenario-check` |

The custom skills are prompt instructions in `singularity/skill-library/<id>/SKILL.md`, attached
through `attachments.yml`. They are not new slash commands or compiled executable SKP packages.
The canonical skills retain pause/session resolution, publication and human approval boundaries.

## Use it from each surface

- **Shell:** `singularity-flow workflow install demo-web-e2e-testing [--dry-run]` adds the starter;
  `singularity-flow documents upload <FILE> --name <NAME>` attaches the screenshot;
  `singularity-flow capability test-setup --json` inspects test runners;
  `singularity-flow mcp scaffold playwright`, `singularity-flow mcp attest` and
  `singularity-flow mcp smoke` set up the browser host;
  `singularity-flow submit --decision verdict=pass` (or `repair`, `blocked`) records the verdict;
  `singularity-flow approve`, `singularity-flow decision show` and `singularity-flow decision choose`
  review and route; `singularity-flow workflow simulate demo-web-e2e-testing --json` inspects the
  lifecycle. Run `singularity-flow workflow --help` for the exact forms supported by this build.
- **Copilot:** `/sf-upload` attaches the screenshot, `/sf-test-setup` configures test commands,
  `/sf-mcp` configures the Playwright host, and the phase routes in the table above
  (`/sf-document-intake`, `/sf-scenario-check`, `/sf-code`) do the work. `/sf-submit`,
  `/sf-approve <phase>` and `/sf-decide` submit, review and route. Use
  `/sf-workflows simulate demo-web-e2e-testing --json` for the structural lifecycle.
- **VS Code:** **Singularity Flow: Workflow Studio** adopts the starter and duplicates the seed;
  **Singularity Flow: Attach Evidence & Designs** attaches the screenshot to the Story;
  **Singularity Flow: Capability Test Setup** and **Singularity Flow: Configure MCP Tools** open
  Configuration Center's test and MCP setup; **Singularity Flow: Submit Current Story Phase** asks
  for the verdict value; **Singularity Flow: Approve…** and **Singularity Flow: Choose What Happens
  Next** review and route. There is no VS Code command for workflow simulation; use the Shell or
  Copilot form.

## Guided workflow

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

To inspect the structural lifecycle before you start, use
`singularity-flow workflow simulate demo-web-e2e-testing --json` (Copilot:
`/sf-workflows simulate demo-web-e2e-testing --json`). Simulation runs no app, browser or tests and
does not grant approval.

## State and safety

- **Pinned bytes.** Story snapshots pin the exact agent and skill bytes; workflow export/import
  carries these dependencies.
- **Browser permissions.** The seed allows the existing `playwright` host only for this demo tester
  in check/retest, without changing any existing agent's browser permissions.
- **Route limits.** Each decision allows two automatic backward routes before pausing for explicit
  human direction. The human can review another permitted attempt, revise intake or cancel; a
  failed/blocked verdict cannot take the Finish route.
- **What counts as proof.** A screenshot is not proof of interactions or exact test execution.
  Visual inspection is labelled honestly; exact image-diff assertions require a real diff runner.
  References and tolerances are not softened to make a check pass.
- **Approval.** A failure report approved by a human authorizes repair, not acceptance. Simulation
  does not grant approval.

## Troubleshooting

- **No screenshot to test against:** upload the real expected image with `/sf-upload`; the starter
  never fabricates or assumes one.
- **The browser check cannot run:** MCP browser use needs host setup, authorized tools and a live
  smoke check. Configure the host with `/sf-mcp` and the test commands with `/sf-test-setup`; the
  starter installs nothing itself. Submit a `blocked` verdict rather than a guessed result.
- **A pass cannot finish:** a pass without edits also needs the human's implementation-applicability
  decision; record it with `/sf-decide`.
- **The Story paused after repeated failures:** the decision used its two automatic backward routes.
  `/sf-decide` shows the permitted options, such as another reviewed attempt; revise intake for
  changed intent, or cancel the Story.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a
  command from the label.

## Related topics

Continue with `sflow explain document-test-repair`, `sflow explain workflow-authoring`, `sflow explain workflow-decisions`, `sflow explain story-lifecycle`, `sflow explain approvals`.
