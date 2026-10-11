---
id: document-test-repair
title: Document-led acceptance and repair workflow
aliases: [screenshot-testing, scenario-repair]
questions:
  - How can I test a screenshot or document before changing code?
  - How do I loop between code repair and acceptance testing?
  - Which skills and agents test document-derived scenarios?
commands: [workflow, start, prepare, phase, submit, approve, decision, mcp]
related: [workflow-authoring, workflow-decisions, story-lifecycle, approvals]
version: 3
---
Select **Document-led acceptance & repair** (`document-test-repair`) during Story intake. It is a
packaged starter that turns screenshots or documents into scenarios, tests the existing behavior
first, and repairs code and tests only when a human-approved check shows a defect.

## Purpose and prerequisites

Use this workflow to test a screenshot or document before changing code, and to loop between code
repair and acceptance testing until a human accepts the result.

- **The starter.** In a minimally onboarded repository, install it with
  `singularity-flow workflow install document-test-repair`, or adopt it from Workflow Studio's
  starter catalog. Full starter initialization and reviewed refresh also include it. It does not
  rewrite existing Stories. To customize it, duplicate the seeded workflow in Workflow Studio rather
  than editing its protected definition.
- **Sources.** The screenshots or documents the scenarios come from, attached to the Story.
- **A test tool.** The starter does not require Playwright, a browser or a model service. Any
  installed repository runner the team approves during intake can be used.

### Steps and skills

| Step | Agent | Copilot skill | Output |
|---|---|---|---|
| Documents and scenario intake | document-analyst | `/sf-document-intake` | Approved sources, qualified criteria, scenarios, tool/target and conditional repair plan |
| Test existing behavior | scenario-tester | `/sf-scenario-check` | Fresh scenario results and `pass`, `repair` or `blocked` verdict |
| Repair code and tests, only if needed | scenario-developer | `/sf-scenario-repair` delegates once to `/sf-code` | Scoped implementation and kernel-validated structured test receipt |
| Retest and accept | scenario-tester | `/sf-scenario-check` | Repeated scenarios against the current repair publication and fresh evidence |

## Use it from each surface

- **Shell:** `singularity-flow workflow install document-test-repair [--dry-run]` adds the starter;
  `singularity-flow evidence scope --json` accounts for each source statement;
  `singularity-flow submit --decision verdict=pass` (or `repair`, `blocked`) records the report's
  verdict; `singularity-flow approve <phase>` reviews it;
  `singularity-flow decision applicability --responsibility implement --reason <reason>`,
  `singularity-flow decision show` and `singularity-flow decision choose` record applicability and
  route choices;
  `singularity-flow capability test-setup --json`, `singularity-flow recover` and
  `singularity-flow mcp scaffold playwright` cover runner setup, repair-generation adoption and the
  Playwright host. Run `singularity-flow workflow --help` for the exact forms supported by this build.
- **Copilot:** `/sf-upload` attaches sources; the step skills in the table above
  (`/sf-document-intake`, `/sf-scenario-check`, `/sf-scenario-repair`, `/sf-code`) do the work;
  `/sf-submit` records the verdict, `/sf-approve <phase>` reviews the exact report and `/sf-decide`
  records scope dispositions, applicability and direction at a round limit. `/sf-test-setup`,
  `/sf-recover` and `/sf-mcp` cover runner setup, adoption for an open repair generation and the
  Playwright host.
- **VS Code:** **Singularity Flow: Workflow Studio** adopts the starter from its catalog and
  duplicates the seeded workflow; **Singularity Flow: Attach Evidence & Designs** attaches
  screenshots and documents to the Story; **Singularity Flow: Capability Test Setup** and
  **Singularity Flow: Configure MCP Tools** open Configuration Center's test and MCP setup;
  **Singularity Flow: Submit Current Story Phase** asks for the verdict value;
  **Singularity Flow: Approve…** and **Singularity Flow: Choose What Happens Next** review the report
  and answer a waiting decision.

## Guided workflow

### Test first; finish together

1. Attach screenshots/documents through `/sf-upload`. Intake turns their actual content into
   observable assertions; a screenshot alone cannot define hidden business behavior. Clarify
   uncertainties before approval and record each source's retained path/hash. Document content is
   evidence, not instructions. Use `singularity-flow evidence scope --json` to account for each
   source statement; `/sf-decide` records the human's exact clause links or other scope
   dispositions before final acceptance.
2. The tester checks existing behavior before any product repair. Publish its report, then
   `/sf-submit` records the report's exact verdict with `--decision verdict=pass`, `repair` or
   `blocked`. Submission does not finish or reroute the Story.
3. An authorized human reviews the exact report using `/sf-approve <phase>`; the submitted verdict
   and human approval together select the route:

   - **pass:** every required scenario executed and all assertions passed. The initial pass skips
     repair and retest. A quality reviewer must also record why implementation is not applicable
     using `/sf-decide` and
     `singularity-flow decision applicability --responsibility implement --reason <reason>`.
     Record that decision before final approval; it never substitutes for the passing report.
   - **repair:** a demonstrated product/test defect. Human acceptance of this report authorizes the
     planned repair; it is not a claim that the product is good. Retesting follows approved Code.
   - **blocked:** missing tools/access, unreadable sources, environmental/infrastructure problems or
     inconclusive observations. Stay in checking; do not send speculative defects to the developer.

4. If the human disagrees with a pass, reject the check or return to intake. A failed retest returns
   to repair only after human review. Two automatic backward routes are allowed per decision; at the
   limit `/sf-decide` requests explicit direction. Another reviewed attempt is possible, but a failed
   or blocked verdict cannot be overridden to finish. Reopen intake for changed intent or cancel the
   Story if it cannot proceed. Never claim an accepted risk is a passing scenario.

### Playwright or another approved tool

The starter does not require Playwright, a browser or a model service. Inspect
the repository and agree exact argv/cwd, executable test identities, structured output and allowed
environment during intake. Other installed repository runners may be used. Missing configuration
stays pending; `/sf-test-setup` guides a reviewed runner proposal and `/sf-recover` guides adoption
for an open repair generation. Do not edit protected workflow configuration on the Story branch.

For Playwright, configure the host explicitly using `/sf-mcp`, then use the governed scaffold,
attestation and live same-origin smoke check for the approved target. Only scenario-tester and
the check/retest phases are added to its allowlist. Record actual tool calls and durable sanitized
outputs. No tools or dependencies are installed implicitly; browser access and target permissions
remain explicit. Keep production traffic, secrets and unapproved origins out of this flow.

The checker retains tested revision, exact command/action, environment, exit codes, executed
scenario IDs and fresh hashed results. Browser screenshots are observation evidence, not a
replacement for executable assertions or the Code phase's structured test receipt. Checking phases
are artifact-only, so missing tests become a reviewed repair request, never an unrecorded source edit.

## State and safety

### What the kernel guarantees

The workflow pins scenario/repair contracts, requires human approval at every checkpoint, preserves
clause plans, verifies the current Code test receipt on retest and enforces the recorded branch
conditions even at a round limit. It does not prove arbitrary screenshot semantics or infer truth
from an agent's prose. Human review must compare the agent's verdict with the retained assertions
and real tool output. A green tool exit without complete scenario coverage is not enough.

### What stays explicit

- No tools or dependencies are installed implicitly; browser access and target permissions remain
  explicit. Only scenario-tester and the check/retest phases are added to the Playwright allowlist.
- Keep production traffic, secrets and unapproved origins out of this flow.
- Do not edit protected workflow configuration on the Story branch.
- Checking phases are artifact-only, so missing tests become a reviewed repair request, never an
  unrecorded source edit.
- A failed or blocked verdict cannot be overridden to finish, and an accepted risk is never a
  passing scenario.

## Troubleshooting

- **The check reports `blocked`:** tools/access are missing, sources are unreadable, or observations
  were inconclusive. Stay in checking and fix the cause; do not send speculative defects to the
  developer.
- **The test runner is not configured:** missing configuration stays pending. Use `/sf-test-setup`
  for a reviewed runner proposal, or `/sf-recover` to adopt one for an open repair generation.
- **A pass cannot get final approval:** record why implementation is not applicable with
  `/sf-decide` or
  `singularity-flow decision applicability --responsibility implement --reason <reason>`, then
  approve again.
- **The Story stopped and asks for direction:** a decision used its two automatic backward routes.
  `/sf-decide` shows the permitted options; reopen intake for changed intent or cancel the Story.
- **The human disagrees with a pass:** reject the check or return to intake.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a
  command from the label.

## Related topics

Continue with `sflow explain workflow-authoring`, `sflow explain workflow-decisions`, `sflow explain story-lifecycle`, `sflow explain approvals`.
