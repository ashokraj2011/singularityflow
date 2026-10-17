---
id: agents-and-routing
title: Agents, assignments, and model routing
aliases:
  - agents
  - agent-routing
  - assign
commands:
  - agent
  - agents
  - assign
related:
  - world-model
  - model-independence
  - assignments-and-watchlists
  - skill-master
version: 7
---
Phase activation selects an agent from pinned policy. Human approval authority remains separate from agent selection, and explicit overrides are local and audited.

The bundled model-routing policy uses the provider selector `auto`, so Copilot chooses the
concrete model for each isolated ACP invocation. SFlow still owns the task mapping, tool boundary,
budgets, and audit receipt. A repository may govern a concrete model in
`singularity/modelTiers.yml`, and an explicit command override remains available where documented;
both are recorded and fail closed if the provider substitutes another model.

A tier may also carry `params.effort` (Copilot reasoning effort: none, minimal, low, medium,
high, xhigh or max) and `params.autoTier` (the Auto routing profile, such as efficiency). Which
tiers send them is configurable with `sendParameters` in `singularity/modelTiers.yml`: `none`,
`all`, or a list of tasks. The bundled map sends only `summarize` (`autoTier: efficiency`,
`effort: low`), which repository briefs, explanations, narration and PR polish route through;
`all` also sends `reason` `effort: high`, which raises the cost of code generation and Auto. Every
tier's params are recorded on each invocation receipt, with the ones sent under
`routing.sentParameters`, and the Configuration Center Model routing tab marks them.

An agent can attach skills from the skill master, each for some of its steps and with a line on
when to use it; in those steps the skills' instructions are part of its prompt. Any agent, a
seeded workflow's included, can be attached skills in `singularity/skill-library/attachments.yml`
without changing the agent (`sflow explain skill-master`).

## Duplicate and customize an agent

In **Workflow Studio → Agents**, choose **Duplicate agent** on a built-in or custom agent.
You can also duplicate the drafting agent from an editable workflow's canvas. The editor opens
with an available copy name; rename it, change its description, tools or instructions, then choose
**Add agent to changes**. Check the changes and publish them through the normal configuration review.
The original agent is unchanged, and built-in agents remain read-only.

The copy keeps the source's instructions, tools and skill attachments, including phase filters
and usage conditions. Referenced skills and reusable instructions stay
linked to the same catalog objects; they are not independent copies. Remote-resource bindings and
trust are not copied: add and review any remote resources separately for the new agent.
World Model context is selected by the phase policy; retired view bindings are not re-enabled.

No step is reassigned automatically. Select the copy as the drafting agent in an editable workflow,
or explicitly select default steps in the creation form. To customize a seeded workflow, duplicate
that workflow first. Duplicating an agent does not change running Stories or their pinned configuration.

## Purpose and prerequisites

Use this topic when the current goal matches **agents and routing**. Start in a repository that uses Singularity Flow unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow agent`, `sflow agents`, `sflow assign`. Run `singularity-flow agent --help` for the exact forms supported by this build.
- **Copilot:** `/sf-agent`, `/sf-agents`. The skill must preserve the CLI result and ask before it changes anything.
- **VS Code:** open Singularity Flow **Configuration Center**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

These commands can change repository or machine-local state: `agent`, `agents`, `assign`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain world-model`, `sflow explain model-independence`, `sflow explain assignments-and-watchlists`.
