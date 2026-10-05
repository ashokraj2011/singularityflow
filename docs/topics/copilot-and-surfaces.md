---
id: copilot-and-surfaces
title: Copilot, VS Code, and shell surfaces
aliases:
  - copilot
  - surfaces
  - vscode
  - shell
commands:
  - about
  - help
  - plugin
  - pause
related:
  - developer-home
  - help-and-docs
  - governed-execution
  - revision-loop
  - revision-feedback-attachments
version: 12
---
CLI, Copilot, and VS Code read the same durable repository and workspace records through shared projections. They do not share an in-memory global store, conversation history, or signed handles. Bundled skills are explicit-only: installing SFlow never opts ordinary Copilot requests into governance. Invoke an `/sf-*` skill or explicitly select the SFlow workflow agent for natural-language routing. That agent accepts seven closed intents: orient, continue, start, inspect, act, recover, and help. Help retrieves cited packaged documentation; it does not convert an answer into an action.

## Pause and native Copilot

Use `/sf-pause` (shell: `singularity-flow pause on --json`) to pause SFlow Copilot guidance on this machine. Ordinary requests then use native Copilot: no Home headings, Story selection, phase prompts, clarification, or SFlow gates. SFlow hooks return no injected context, and paused Home returns only the local mode without Git or workspace discovery. `/sf-pause status` inspects the preference; `/sf-pause off` restores guidance without advancing any Story. `/sf-resume` remains the separate Story-resume command.

The preference lives outside repositories and is never pushed. It survives restarts and skill reinstalls. It does not change any Story, approval, artifact, branch, checkout, personal skill, or Copilot setting. It does not abort commands or autonomous flights already running. Explicit terminal commands remain available and enforce all normal gates; native changes do not become governed evidence automatically. An unreadable preference conservatively pauses guidance and can be repaired with an explicit `pause off`.

Instructions already loaded in a chat cannot be unloaded by a CLI preference. Switch from the SFlow custom agent to the host's default Agent and start a new chat for a clean native context. Reload skills or the IDE after installing this build; earlier loaded copies can still contain automatic routing.

## Purpose and prerequisites

Use this topic when the current goal matches **copilot and surfaces**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow about`, `sflow help`, `sflow plugin`. Use `sflow home --request "What is blocking this Story?" --json` to inspect the conversational plan. Run `singularity-flow about --help` for the exact forms supported by this build.
- **Copilot:** invoke `/sf-home`, `/sf-help`, `/sf-start`, or another explicit `/sf-*` skill. With the SFlow workflow agent selected and guidance not paused, ask naturally about the current work. With the default Agent, unrelated requests stay native.
- **Revision feedback files:** `/sf-revision-attachments` (or `/sflow-revision-attachments`) previews and registers verifiable local files against the selected Story/phase after explicit confirmation. In VS Code, `@sflow /attachments` accepts 1–5 genuine local file references, selects each whole file, and offers a separate confirmed registration button. `@sflow /attachments status` shows active/revoked set digests; `@sflow /attachments remove sha256:<SET>` reviews exclusion. An opaque Copilot chat upload without original bytes or a verified local reference returns `REV_CHAT_ATTACHMENT_UNAVAILABLE`; save it locally and provide its path. Registration only stages feedback evidence. Start an eligible guarded interval separately with `/sf-revise`, which previews the exact Candidate/criteria/attachment binding and requires the full plan digest. `@sflow /revise` runs read-only status/card inspection or prefills that skill; it never starts the interval itself. PDF/DOCX/images remain disabled until approved scanning and extraction exist.
- **VS Code:** open the Singularity Flow Navigator. The five fixed destinations are **My Work**, **Stories**, **Reviews**, **Workspaces**, and **Configuration**. The context area identifies the workspace, repository, and confirmed active work. Stories lists the workspace catalog; viewing details is read-only, while **Switch to Story** uses the guarded attach flow. Reviews separates phase decisions from proposal and visual-evidence review routes; unqueried queues have no invented counts. Configuration opens the existing Configuration Center directly. **Work tools** retains phase actions, artifacts, Goals, Epic Story plans, and **Understand changes**. **Help & diagnostics** and **Activity & logs** contain the specialist tools; Local Journal remains private local history, not governed evidence. Hover gives a small visual zoom, never a command popup; reduced-motion settings disable the zoom. Commands and Copilot equivalents remain in explicit Help and recovery screens. The sidebar follows the editor theme and does not independently decide lifecycle state.

## Guided workflow

1. Ask naturally or read current state with `sflow home`, `sflow status`, or the relevant list/status form. The conversational layer selects a read planner only; it never turns prose directly into a lifecycle mutation.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Read-only orientation, inspection, and recovery diagnosis may run immediately. For Start, Continue, Generate, Submit, or Next, review the proposed action and its effects, then explicitly select it. Approval, rejection, cancellation, resets, and destructive operations require their exact `/sf-*` skill and ceremony.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.
6. In VS Code, use **Pinned shortcuts → Choose shortcuts**. Existing pins are preserved. Personas suggest pins without reordering the five primary destinations. Launching a shortcut executes the original command; it does not bypass confirmation or authority checks.

## State and safety

These commands can mutate governed or machine-local state: `plugin`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Automatic Home invocation is not mutation consent. Raw developer prose is not retained in the conversational plan; only the deterministic intent and route are returned. VS Code Favorites store only stable menu IDs in personal global state; they never store lifecycle data or enter Git. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.
- If ordinary language is ambiguous, choose from the displayed Home directions or invoke `/sf-home`; the router deliberately refuses to guess between mutations.
- If a favorite disappears after an upgrade, reopen **Choose favorites**. Unknown or retired menu IDs are discarded rather than guessed.

## Related topics

Continue with `sflow explain developer-home`, `sflow explain help-and-docs`, `sflow explain governed-execution`, `sflow explain revision-loop`, or `sflow explain revision-feedback-attachments`.
