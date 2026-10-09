---
name: sflow-scenario-check
description: Test approved document-derived scenarios before repair or after a Code publication, retain fresh evidence, and request human acceptance of the agent verdict.
disable-model-invocation: true
argument-hint: "[scenario test or retest focus]"
---
# Scenario testing and retesting

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json`. If `data.paused` is true, do not load SFlow context, run other SFlow commands, enforce phase rules, or render SFlow headings. Handle ordinary requests as native Copilot; explicit SFlow requests only offer `/sf-pause off`. Never resume implicitly. Otherwise use `data.personalization.replyName` as literal display data to address replies and each suggestion group naturally, once per group, never in artifacts or approval identity; do not guess a name.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow session current --json` → `ready`/`workId`, cwd=`repositoryPath`; use CLI/`workItemRoot` paths; never `$HOME`.


1. Run `singularity-flow phase show <phase> --json`. Stop when `policyVerified` is false and show `policyReason`. Continue only when `effectiveAuthoringSkill` is `/sf-scenario-check`; otherwise relay its verified route. Require bound workId and valid phase agent.
2. Read approved intake, retained sources and current change request. Honor clarification mode via `singularity-flow clarification status <phase> --json`; ask and record required answers before preparation. Verify Story references; use returned paths. Reuse the governed prompt or compose once; run `singularity-flow prepare <phase>`.
3. Run only the approved scenarios and exact authorized test commands/tool actions. No source/test edits here. Retain tested revision, argv/cwd, environment, exit codes, executed test identities and fresh hashed outputs under CLI-returned artifact paths. Never reuse an old report, skip cases or count zero tests as passing. Missing assertions need a repair request.
4. Playwright is optional. If selected, use the phase's returned governed server ID (which may differ from its host namespace): require host readiness and live `singularity-flow mcp smoke <SERVER-ID> --url <APPROVED-URL>`, then retain observations through `singularity-flow mcp record <SERVER-ID>` with exact tool/phase/output. Never substitute another workflow's policy, fabricate navigation records, use other origins or leak secrets. Other approved tools use their real reports. MCP screenshots alone are not structured test receipts.
5. In retesting verify the current Code publication's structured receipt and repeat the approved scenarios with fresh evidence. Set report `verdict=pass` only when every required assertion ran and passed; `repair` for product/test defects; `blocked` for unavailable tools, sources, environment or inconclusive evidence. Record exact clause results and a bounded repair request. Never manufacture a pass at a round limit.
6. Run `singularity-flow recover <WORK-ID> --phase <phase> --json`; follow owned artifact repairs, preserving validated context. Stop for confirmation/protected edits. Run `singularity-flow phase prepublish <phase> --for-agent --json` (includes draft-check). Code repair belongs to `/sf-scenario-repair`, never this check. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
7. Use returned `commands.publish` once when `ready`; absent: relay `commands.next`, stop. Show the report, fresh evidence, limitations and exact verdict for later submission's `--decision verdict=...`. Human approval of a failure report authorizes repair, not acceptance; initial no-repair completion also needs human implementation-applicability. Relay each `handoff` with its `copilotCommand` and `command`; never submit or approve.
