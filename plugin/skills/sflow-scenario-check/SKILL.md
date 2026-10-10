---
name: sflow-scenario-check
description: Test approved document-derived scenarios before repair or after a Code publication, retain fresh evidence, and request human acceptance of the agent verdict.
disable-model-invocation: true
argument-hint: "[scenario test or retest focus]"
---
# Scenario testing and retesting

<!-- sflow-copilot-pause -->
First run `singularity-flow phase enter --for-agent --json` once. Lookup from current cwd (non-Git allowed). Never search `/Users`, `$HOME` or parents for a repo. Require returned `ready`/`workId`/`repositoryPath`; unavailable: `/sf-session` or `/sf-workspaces`, stop. It checks pause before Git. If `paused`, native Copilot; only offer `/sf-pause off`, never resume implicitly. Otherwise follow `agentGuide.readOrder` once, reuse binding/recovery/clarification/references and delivered inputs; no duplicate lookups. Use `personalization.replyName` literally in replies, never artifacts or approval identity.

<!-- sflow-output-contract: clarification-and-artifact -->
**Output contract:** Use governed inputs and pinned clarification; publish/show configured artifacts. Honor returned `commandGuidance`: show Shell, Copilot and available `modelFreeCommand` as "VS Code (model-free)". Missing Copilot: "Copilot: no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, valid `phaseAgent`; cwd=`repositoryPath`. Returned `workItemRoot`/artifact paths only; never `$HOME`.


1. Use entry `authoring`. Stop when `policyVerified` is false and show `policyReason`. Continue only when `effectiveAuthoringSkill` is `/sf-scenario-check`; otherwise relay its verified route. `retained-generation`: relay `next`, stop.
2. Review recovery/diffs; stop for protected/unowned edits or human decisions. `successor-preparation-required`: run `successor.preparation.command`, preserve drafts/publications, refresh entry once. Run `singularity-flow phase enter <phase> --work-id <WORK-ID> --compose --for-agent --json` once; use `context.text`, clarification/reference paths. Not admitted: relay blockers/next, stop. Required clarification: ask/record before preparation. Expand only needed missing/truncated inputs. Run `singularity-flow prepare <phase>` unless prepared.
3. Run only the approved scenarios and exact authorized test commands/tool actions. No source/test edits here. Retain tested revision, argv/cwd, environment, exit codes, executed test identities and fresh hashed outputs under CLI-returned artifact paths. Never reuse an old report, skip cases or count zero tests as passing. Missing assertions need a repair request.
4. Playwright optional: use the returned governed server ID, require host readiness and live `singularity-flow mcp smoke <SERVER-ID> --url <APPROVED-URL>`; retain exact tool/phase/output with `singularity-flow mcp record <SERVER-ID>`. No other workflow policy/origins, fabricated records or secret leaks. Other approved tools retain real reports. MCP screenshots are not structured test receipts.
5. In retesting verify the current Code publication's structured receipt and repeat the approved scenarios with fresh evidence. Set report `verdict=pass` only when every required assertion ran and passed; `repair` for product/test defects; `blocked` for unavailable tools, sources, environment or inconclusive evidence. Record exact clause results and a bounded repair request. Never manufacture a pass at a round limit.
6. Preserve validated context. Run `singularity-flow phase prepublish <phase> --for-agent --json` (includes draft-check and recovery); follow owned artifact repairs. Stop for confirmation/protected edits. Code repair belongs to `/sf-scenario-repair`, never this check. Follow returned `repairLoop.protocol` for persistent correction/resume; stop unchanged.
7. Use returned `commands.publish` once when `ready`; absent: relay `commands.next`, stop. Show the report, fresh evidence, limitations and exact verdict for later submission's `--decision verdict=...`. Human approval of a failure report authorizes repair, not acceptance; initial no-repair completion also needs human implementation-applicability. Relay each `handoff` with its `copilotCommand` and `command`; never submit or approve.
