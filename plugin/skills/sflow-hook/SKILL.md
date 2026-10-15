---
name: sflow-hook
description: Diagnose or explicitly invoke a Singularity Flow lifecycle hook using its exact host-supplied payload.
disable-model-invocation: true
argument-hint: "turn-intent|turn-end|agent-start|session-start|agent-guard"
---
# Inspect or invoke lifecycle hooks

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. Act on a result's `act` first: its state, `do` routes and any `ask`. A bounded result lists `omittedFields` with exact line ranges in `agentOutput.path`; read only those you need with your file tool. Never stop because a result is long or was saved to a file.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

Hooks are host integration points, not shortcuts for lifecycle commands.

1. Prefer `/sf-logs` when the user only wants to understand a hook decision.
2. Invoke `singularity-flow hook <HOOK>` only when the user explicitly requests the hook and provides the exact payload or environment required by that host contract.
3. Preserve allow/deny, reason, selected work, session, agent, and exit status exactly.
4. Never fabricate host identifiers, bypass a guard, or translate a denied hook into a direct mutation.

