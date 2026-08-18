---
id: goals-and-outcomes
title: Goals, outcomes, and governed work
aliases:
  - goals
  - goal
  - outcome-goals
commands:
  - goal
related:
  - developer-home
  - workspaces-and-sessions
  - story-lifecycle
  - initiative-lifecycle
version: 1
---
A Goal is a personal, workspace-scoped outcome with observable success criteria. It can organize several governed Stories or Initiatives without becoming a new approval rail or lifecycle. The Goal record is local advisory state; linked work remains governed by its own pinned workflow, authorities, Git branches, artifacts, and evidence.

## Purpose and prerequisites

Use a Goal when the desired outcome is broader than one bounded task or may span multiple work items or sessions. Select a workspace first. Creating a Goal requires an outcome statement and at least one observable success criterion. Linking requires the Story or Initiative to exist in a materialized workspace repository or its local remote-tracking state.

## Use it from each surface

- **Shell:** use `sflow goal list`, `sflow goal create "<outcome>" --success "<criterion>"`, and `sflow goal next`. Run `singularity-flow goal --help` for every supported form.
- **Copilot:** invoke `/sf-goal`. The skill reads durable Goal state first, asks for missing outcome and success information, and requires explicit confirmation before changing a Goal.
- **VS Code:** use My Work for governed Story navigation. Goal data uses the same selected workspace and is available to extension integrations through `singularity-flow goal ... --json`; Goal state must not be reconstructed from editor memory.

## Guided workflow

1. Select the intended workspace with `sflow workspace use <WORKSPACE>` and inspect current work with `sflow home`.
2. Create an outcome with one or more observable success criteria. A criterion should describe what a person can verify, not an implementation activity such as “write code.”
3. Optionally link an existing Story or Initiative. Linking validates the subject and records its repository, canonical branch, title, and identity; it does not check out, start, advance, or publish that subject.
4. Use `sflow goal next` to obtain one grounded navigation action. The action may attach a linked Story, open Initiative next steps, repair a missing link, or offer Goal completion after all links are terminal.
5. Use `sflow goal show` to review criteria and live linked-work states. Switch between active Goals with `sflow goal use <GOAL-ID>`.
6. Complete with the exact Goal-ID confirmation only after the outcome is achieved. Abandoning also requires the exact ID and a reason, and preserves the Goal history.

## State and safety

Goal state is stored under the selected workspace's local `.singularity-flow` directory with authority `personal-advisory`. CLI, Copilot, and future VS Code Goal surfaces read the same record. The store uses atomic writes and a workspace lead-repository mutation lock. Symbolic-link escapes and state belonging to a different workspace copy are refused.

Goal operations never grant approval authority, alter a phase, write a governed artifact, move a Git ref, push a branch, or call an external system. Completing a Goal is a human acknowledgement of an outcome; it is not a proof receipt. A proof-oriented Goal must eventually use a typed success oracle and reproducible evidence rather than reusing ordinary Goal completion.

## Troubleshooting

- If no workspace is selected, run `sflow workspace list` and `sflow workspace use <WORKSPACE>` before retrying.
- If linked work cannot be found, confirm its repository and kind, then fetch or attach it through `/sf-session`; Goal linking does not fetch implicitly.
- If a Goal cannot complete, inspect every linked subject. Active or unavailable work must be completed, abandoned, repaired, or explicitly unlinked first.
- If the store is invalid or belongs to another workspace copy, preserve it for diagnosis and repair the workspace selection. Do not copy Goal bytes over a different workspace.
- If a returned action would mutate governed state, follow its named `/sf-*` skill and confirmation flow. Goal selection itself is not mutation consent for the linked work.

## Related topics

Continue with `sflow explain developer-home`, `sflow explain workspaces-and-sessions`, `sflow explain story-lifecycle`, or `sflow explain initiative-lifecycle`.
