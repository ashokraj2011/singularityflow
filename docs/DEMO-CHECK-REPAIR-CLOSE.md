# Demo — Check, Repair & Close

Starter ID: `demo-check-repair-close`.

| Phase | Agent | Agent-attached library skill | Output |
|---|---|---|---|
| `demo-intake` | `demo-intake-analyst` | `demo-acceptance-intake` | Intake and acceptance agreement |
| `demo-check` | `demo-code-checker` | `demo-code-acceptance-check` | Fresh scenario/test/visual results |
| `demo-repair` | `demo-code-repairer` | `demo-scoped-code-repair` | Implementation and regression summary |
| `demo-close` | `demo-story-closer` | `demo-evidence-bound-close` | Closing report and operational handoff |

The skills live in `singularity/skill-library/<id>/SKILL.md` after installation, appear in
Skills, and are linked in each agent's **Attached skills** table. The prompt composer includes
the exact skill instructions and hashes only for their configured agent/phase. They follow those
agents when reused; ordinary developers/testers and other workflows do not inherit them.
Workflow export/import and duplication carry the agents, skills and attachment identities.

## Route

Intake → Check → Repair → Check, repeating until a fresh pass; then Close.
An initial pass goes straight to Close without unnecessary product changes. Repair always
returns to the independent checker, unless reviewed changed intent returns to Intake.

At Check submission record `--decision verdict=pass|repair|blocked`; at Repair submission
record `--decision next=recheck|revise-intake`. The normal CLI returns the exact Copilot/terminal
handoff. Human approvals review these evidence-backed facts before automatic routing. A pass
skipping additional repair requires the returned human implementation-applicability decision.
Final approval of the closing report ends the Story; neither agent claims approval itself.

There are three automatic backward routes per decision, then the engine requests explicit human
direction. Blocked access, unavailable tools, skipped required tests and inconclusive evidence
never become a pass. Human disagreement uses normal reject/rework; preserved work remains intact.

## Inputs and tools

Provide screenshots, documents or Story details during intake. Agree test commands/environment,
repair paths and (when relevant) viewport, reference state and visual tolerance. Testing is not
run at intake. Playwright MCP is optional and scoped to the checker; an approved existing test
runner works too. No silent package installation or production access is granted.

The checker uses governed server ID `demo-playwright`, bound to host namespace `playwright`.
Host setup uses the standard Playwright scaffold; warm, readiness, smoke and observation records
use the returned `demo-playwright` policy ID. Shared host configuration does not let another
workflow's receipts or permissions satisfy this policy.

After a repair, Check binds tests to current source bytes and retained repair history instead of
reading a stale first-check report. Closing consumes the latest approved Check; Repair is optional
because a no-change pass legitimately skips it. Actual test execution, screenshot classification,
visual witnesses, risk acceptance and human approval are distinct records.

New onboardings receive this starter. For an existing repository, use Workflow Studio's packaged
starter installation or `singularity-flow workflow install demo-check-repair-close` through the
repository's configuration authority. Existing Stories keep their pinned workflow. Duplicate the
starter to customize it rather than editing a seeded definition.
