# Execution and integration policy boundary

Four kernel modules own the existing automatic-run, Ad Hoc, MCP and after-step action rules.
`auto-policy` retains the limits, stopping points, capability-policy tightening and nonwaivable
authority constraints. `adhoc-policy` retains baseline, promotion, landing and reconciliation
requirements. `mcp-policy` validates declarations, phase/agent permissions and evidence
requirements. `step-action-policy` validates targets and actions, pins their settings, and selects
the actions an accepted lifecycle event makes eligible.

The extraction moves 46 existing rule bodies without changing their syntax. The native modules
preserve their exported names and re-export the same functions and policy constants. Production
consumers import the new owners directly. Nine compiler dependencies become direct kernel rules
that a construction callback cannot replace; 42 native compatibility collaborators remain.

These modules import only the foundation error contract. URL parsing validates supplied target
text; it does not resolve DNS, acquire secrets, connect a server, run a provider or deliver an
event. MCP machine discovery, setup, prompt rendering and host/evidence checks stay native.
Event/receipt hashing, target output rendering, event summaries and delivery/pipeline effects
also stay native. Choosing an action is not a receipt proving it was delivered, and a policy
declaration does not grant approval, add execution capability or waive a human checkpoint.

Compatibility evidence captures 71 native outcomes from `2c7823c47`, including input mutations,
normalization, exact refusal details and all four native API inventories. Fingerprints cover all
46 moved function bodies; identity checks prove that compatibility exports use the same rules.
Additional checks preserve automatic ceiling tightening, forbidden policy waivers and fabricated
clarifications, MCP phase/agent tool constraints, secret-name restrictions and approval triggers.
The existing 43 full compiler observations and constructor override checks remain in force.
Architecture guards, build identity, VSIX source requirements and workflow-intent interpretation
digests include all four owners.

Mac qualification passed 482 tests across 38 files, with no failures, cancellations or skips.
Coverage includes automatic-run authorization, repair limits and crash recovery, native MCP and
delivery adapters, full native Story journeys, the public SDK archive and VS Code packaging.
Source validation passed 3,729 checks, VS Code typechecking passed, and the Git audit retained
2,011 observed sites without new bypasses. All 13 bundle budgets passed unchanged. The gateway
has 849 modules and 6,801,868 bytes, within its existing 852-module limit. These figures qualify
the refactor and its packaging; they do not establish command latency improvements. Qualification
used isolated Mac fixtures, without Windows CI or live provider calls.

This is Phase 5 work required by the future portable runtime. It does not complete project
enrollment, portable lifecycle ports, cross-agent Story execution, authority cutover or final
distribution/performance qualification. Existing Git projects retain their current authority.
