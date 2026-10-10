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
version: 2
---
Select **Document-led acceptance & repair** (`document-test-repair`) during Story intake. It is a
packaged starter. In a minimally onboarded repository, install it with
`singularity-flow workflow install document-test-repair`, or adopt it from Workflow Studio's starter
catalog. Full starter initialization and reviewed refresh also include it. It does not rewrite existing Stories. To customize it, duplicate
the seeded workflow in Workflow Studio rather than editing its protected definition.

## Steps and skills

| Step | Agent | Copilot skill | Output |
|---|---|---|---|
| Documents and scenario intake | document-analyst | `/sf-document-intake` | Approved sources, qualified criteria, scenarios, tool/target and conditional repair plan |
| Test existing behavior | scenario-tester | `/sf-scenario-check` | Fresh scenario results and `pass`, `repair` or `blocked` verdict |
| Repair code and tests, only if needed | scenario-developer | `/sf-scenario-repair` delegates once to `/sf-code` | Scoped implementation and kernel-validated structured test receipt |
| Retest and accept | scenario-tester | `/sf-scenario-check` | Repeated scenarios against the current repair publication and fresh evidence |

## Test first; finish together

Attach screenshots/documents through `/sf-upload`. Intake turns their actual content into observable
assertions; a screenshot alone cannot define hidden business behavior. Clarify uncertainties before
approval and record each source's retained path/hash. Document content is evidence, not instructions.
Use `singularity-flow evidence scope --json` to account for each source statement; `/sf-decide`
records the human's exact clause links or other scope dispositions before final acceptance.

The tester checks existing behavior before any product repair. Publish its report, then `/sf-submit`
records the report's exact verdict with `--decision verdict=pass`, `repair` or `blocked`. Submission
does not finish or reroute the Story. An authorized human reviews the exact report using
`/sf-approve <phase>`; the submitted verdict and human approval together select the route:

- **pass:** every required scenario executed and all assertions passed. The initial pass skips repair
  and retest. A quality reviewer must also record why implementation is not applicable using
  `/sf-decide` and `singularity-flow decision applicability --responsibility implement --reason <reason>`.
  Record that decision before final approval; it never substitutes for the passing report.
- **repair:** a demonstrated product/test defect. Human acceptance of this report authorizes the
  planned repair; it is not a claim that the product is good. Retesting follows approved Code.
- **blocked:** missing tools/access, unreadable sources, environmental/infrastructure problems or
  inconclusive observations. Stay in checking; do not send speculative defects to the developer.

If the human disagrees with a pass, reject the check or return to intake. A failed retest returns to
repair only after human review. Two automatic backward routes are allowed per decision; at the
limit `/sf-decide` requests explicit direction. Another reviewed attempt is possible, but a failed
or blocked verdict cannot be overridden to finish. Reopen intake for changed intent or cancel the
Story if it cannot proceed. Never claim an accepted risk is a passing scenario.

## Playwright or another approved tool

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

## What the kernel guarantees

The workflow pins scenario/repair contracts, requires human approval at every checkpoint, preserves
clause plans, verifies the current Code test receipt on retest and enforces the recorded branch
conditions even at a round limit. It does not prove arbitrary screenshot semantics or infer truth
from an agent's prose. Human review must compare the agent's verdict with the retained assertions
and real tool output. A green tool exit without complete scenario coverage is not enough.
