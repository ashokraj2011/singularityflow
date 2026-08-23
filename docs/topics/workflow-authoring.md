---
id: workflow-authoring
title: Workflow and configuration authoring
aliases:
  - workflow
  - profiles
  - configuration-center
commands:
  - workflow
  - configuration
related:
  - configuration
  - agents-and-routing
  - artifacts-and-generation
version: 5
---
Author work types, ordered phases, gates, artifacts, inputs, and approval policy through governed configuration. Existing work remains pinned to the resolution it started with.

## Purpose and prerequisites

Use this topic when the current goal matches **workflow authoring**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow workflow`, `sflow configuration`. Run `singularity-flow workflow --help` for the exact forms supported by this build.
- **Copilot:** `/sf-help` followed by the documented CLI fallback. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Configuration Center**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## Packaged POC workflow

`POC workflow` (`poc-workflow`) is a seeded Story workflow for a governed UI-regression proof of
concept. It appears in CLI, Copilot, and VS Code workflow selection and runs this contract:

`POC intent and environment → Regression impact analysis → Governed UI exploration → Playwright test generation → Playwright validation and bounded repair → Publication and PR review`

Start it from any surface as a normal new Story. Select an explicit remote base branch first; SFlow
creates and publishes only the isolated Story branch. Intake then records the authorized environment,
test intent, acceptance criteria, viewports, test data, and secret references. Dedicated
least-privilege analyst, explorer, test-developer, and validator agents compare the pinned revisions, record Playwright MCP observations, follow
the repository's existing test and Page Object conventions, and produces exact command and evidence
records. The host must have the Playwright MCP server configured, and every allowed browser call
retains host confirmation and governed provenance.

A failed validation never starts an autonomous healing loop. A quality reviewer may reject to UI
exploration, test generation, or validation for at most two human-authorized repair generations.
The workflow stops blocked when that budget is exhausted. A passing validation advances to a
separate publication review requiring independent quality and engineering approvals. That phase
prepares the Story-branch diff and PR description; it does not create a PR or update the selected
base without an explicit governed publication action.

```bash
sflow workspace branches --json
sflow start POC-101 --title "Checkout regression demonstration" --from-branch develop --work-type poc-workflow
sflow mcp doctor
sflow mcp attest playwright --confirm playwright
sflow mcp smoke playwright --url https://staging.example.test/health
sflow status POC-101
```

## Paired benchmark workflows

The starter configuration also exposes `Benchmark A — governed intelligence` (`benchmarking-a`)
and `Benchmark B — generic context` (`benchmarking-b`). Both run:

`intake → design → implementation → testing → conformance`

They share the same templates, default agents, artifact contracts, write scopes, approval groups,
thresholds, and rejection routes. A requires governed world-model grounding, requests one bounded
optional AST evidence page, and consumes approval-bound agent briefs. If AST is unavailable, A
continues with ordinary repository access. B disables world-model and AST context and consumes full approved artifacts. The resolved
`intelligence` policy is pinned into `workflow.json`, so a later configuration change cannot switch
an active Story between arms.

Use the normal Start wizard in CLI, Copilot, or VS Code and explicitly choose one profile. Run
comparable Stories through both arms and use Flow Impact receipts for outcome analysis. Selecting
arms manually is a benchmark comparison, not randomized causal evidence; use the randomized prompt-
set study when the only variable is prompt wording.

## State and safety

These commands can mutate governed or machine-local state: `workflow`, `configuration`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain configuration`, `sflow explain agents-and-routing`, `sflow explain artifacts-and-generation`.
