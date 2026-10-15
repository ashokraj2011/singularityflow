---
name: sflow-story-skill-version
description: Review and adopt an approved new skill package version for an active Story without silently changing its pinned execution snapshot.
disable-model-invocation: true
argument-hint: "status | preview <SKILL-ID> --reason <TEXT> | propose <SKILL-ID> --reason <TEXT> | decide <AMENDMENT-ID> --decision <approve|reject> --reason <TEXT>"
---

# Review a Story skill-version amendment

<!-- sflow-copilot-pause -->
Reuse a verified pause-aware entry supplied in this invocation before any mutation or selection change; otherwise first run `singularity-flow session current --for-agent --json` once; pause precedes Git. If `paused`: native Copilot, only `/sf-pause off`, never resume implicitly. Reuse binding/`personalization.replyName`; fresh operation checks/consent remain required.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes. On a refusal read `remediationPlan`: run its first read-only step once and follow `context.strategy`; never retry an unchanged condition or edit an earlier phase to clear it. One returned `automatic` plan-hash action (such as `sync`) may run once, then re-enter once. Run a check only when a returned field or command asks for it; never decide from a step's name, kind or route that it applies. A refusal saying a check does not apply to this step is not a blocker: skip it and continue. A command's JSON is complete even when long: if your tool saved it to a file, read that file to its end before acting; never treat a saved or long result as truncated or stop because of its size.
<!-- sflow-execution-boundary -->
**Boundary:** reuse entry `ready`/`workId`, cwd=`repositoryPath`; CLI/`workItemRoot` paths only; never `$HOME`. No duplicate lookup.

1. Read `singularity-flow story skill-version status --json` from the verified Story repository. It reports the pinned version and any pending proposal; it does not read a floating live skill folder as authority.
2. When the person names an approved skill ID and reason, run `singularity-flow story skill-version preview <SKILL-ID> --reason <TEXT> --json`. Show the old and proposed package identities, approved configuration revision, exact plan digest, and each affected, preserved, or unproven dependency. Stop if the CLI reports an unknown dependency, changed policy outside the selected package, unavailable approved bytes, or unsupported snapshot shape.
3. A proposal is a separate governed mutation. Require the person's explicit confirmation of the **full digest returned by the current preview**, then use the CLI's returned `propose` argv with that confirmation. A Copilot-generated assent or a typed digest by itself is not human authorization. Never alter `workflow.json`, a WFA manifest, or evidence files directly.
4. The proposal does not adopt the skill. For `decide`, present the exact proposal and policy to an eligible human reviewer and collect a reason. Run the CLI's read-only decision preview first; only after explicit confirmation use its returned `decide` argv. Distinct identities and any required groups are checked by the existing approval authority. Do not fabricate or copy approvals.
5. Report the committed decision. If the threshold is met and approved, the CLI must create a new immutable snapshot revision and reopen only dependencies it can prove affected; all unproven cases stay blocked. If rejected or pending, the original pinned Story version remains authoritative. Existing publication, checks, and human approval gates still apply to reopened phases.
6. Do not run a selected skill phase from this skill. Host execution remains gated separately; use the returned next action after the adoption transaction is verified.
