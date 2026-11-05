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
  - gateway
  - result
related:
  - developer-home
  - help-and-docs
  - governed-execution
  - revision-loop
  - revision-feedback-attachments
version: 37
---
CLI, Copilot, and VS Code read the same durable repository and workspace records through shared projections. They do not share an in-memory global store, conversation history, or signed handles. Bundled skills are explicit-only: installing SFlow never opts ordinary Copilot requests into a Story. Invoke an `/sf-*` skill or explicitly select the SFlow workflow agent for natural-language routing. That agent accepts seven closed intents: orient, continue, start, inspect, act, recover, and help. Help retrieves cited packaged documentation; it does not convert an answer into an action.

## Pause and native Copilot

Use `/sf-pause` (shell: `singularity-flow pause on --json`) to pause SFlow Copilot guidance on this machine. Ordinary requests then use native Copilot: no Home headings, Story selection, phase prompts, clarification, SFlow gates, or the check that refuses a plain chat a file holding secrets (see [Secrets in plain chats](capability-management.md)). SFlow hooks return no injected context, and paused Home returns only the local mode without Git or workspace discovery. `/sf-pause status` inspects the preference; `/sf-pause off` restores guidance without advancing any Story. `/sf-resume` remains the separate Story-resume command.

The preference lives outside repositories and is never pushed. It survives restarts and skill reinstalls. It does not change any Story, approval, artifact, branch, checkout, personal skill, or Copilot setting. It does not abort commands or autonomous flights already running. Explicit terminal commands remain available and enforce all normal gates; native changes do not become evidence automatically. An unreadable preference conservatively pauses guidance and can be repaired with an explicit `pause off`.

Instructions already loaded in a chat cannot be unloaded by a CLI preference. Switch from the SFlow custom agent to the host's default Agent and start a new chat for a clean native context. Reload skills or the IDE after installing this build; earlier loaded copies can still contain automatic routing.

## What a long result asks you to read

A result too long for the host stays whole in `.sflow/out/`. `agentOutput.read` lists the line ranges this step needs, and a `textFiles` entry marked `need` is a file it needs. A result whose `act` names no fields is read whole. The other `omittedFields` are listed so that a later step can open them by line. The same path holds the same bytes, so a path already read in this chat is not read again.

Source review, submission and approval each read their own packet, so they cost less from a new chat. SFlow's replies suggest one, and VS Code's next-step button opens one for source review. It is advice: each step also works from the chat you are in.

## Copilot extensions

Other extensions can add skills and tools to Copilot, and Copilot reads its starting context again on every call. In VS Code, **Help & diagnostics → Copilot extensions** lists each extension that adds something: its skills with their size, its tools, and advice for this workspace.

- **Turn off here:** it adds skills to every call, and nothing in this workspace matches the files it says it works on.
- **Your call:** it adds skills, and this workspace has files it works on, or SFlow can't tell.
- **Leave on:** it adds no skills, or it's Copilot, VS Code or SFlow.

Skill sizes come from your last chat's own prompt. Copilot reports tools only as one total and can load them on demand, so the page counts them but doesn't price them. It changes nothing itself: **Open in Extensions** shows VS Code's own page, where **Disable (Workspace)** keeps the extension on elsewhere. Start a new chat and choose **Check again** to see the new number.

## A person's own steps, in any chat

Approving or returning a step, recording the decision list and deciding an earlier step's issue are never an agent's. Nor is any step SFlow calls the person's own: taking or turning down Copilot's specification proposals, deciding its gaps, settling, publishing or discarding it, publishing a split, witnessing evidence, binding environment values and releasing a lock among them. The Copilot hook refuses them in an `/sf-*` skill's turn, in a plain follow-up prompt that names no skill, and while guidance is paused. It reads them however the shell line spells them: chained after `cd` or another command, behind `env`, `npx` or a path to the binary, inside a shell's `-c` or a substitution, typed into a running shell, or as the stored command of a plan's action. The refusal names the person's exact command. They run it in their own terminal, or ask for it with `/sf-approve`, `/sf-reject` or `/sf-decide`, which asks them. Every other tool call in a plain prompt keeps native behaviour.

A decision a person records under their approval group is refused in every turn but the one they start for it, in a plain prompt too: scope, applicability, completeness, choice and plan-location decisions (`/sf-decide`), reopening a Story (`/sf-reject`), adjudicating a convergence finding (`/sf-converge`), deciding a source-review finding (`/sf-review-decide`), a constitution exception (`/sf-constitution`), authorizing a repair (`/sf-fix`), consenting to local usage capture (`/sf-telemetry`), an Epic's approvals (`/sf-initiative-approve`), its Story review decisions (`/sf-epic-review-decision`) and its completion (`/sf-epic-complete`). Approving a goal's plan, ratifying or confirming an SGOS intent, approving an SGOS program, a capability break-glass lease, a deployment check's host-policy assertions and the first trust of an agent's dependencies are only ever run in the person's own terminal. Their previews (`--dry-run`, a `program approve` without `--confirm`) stay open.

An agent's publication is its own: in every chat, `phase publish` with `--authored human`, `--authored external-tool`, a manual or `external-tool` channel (`manual-in-place`, `manual-import`, `external-tool`) or no author at all is refused. The refusal names the agent's route, `phase prepublish <PHASE> --for-agent --json --publish-if-ready`, which publishes as `governed-agent` (`copilot-host`) wherever the step permits it, with the kernel's model on or off. A person who wrote the draft themselves publishes it from their own terminal with the second command it names. A step that permits only a person's or an external tool's authorship is never published by publish-if-ready; it shows the person the command. An agent's `act` turns a bare or person-authored `phase publish` route into its own publish-if-ready route.

An SFlow command run with `NODE_ENV=test` or a `SINGULARITY_FLOW_TEST_` variable set is refused in every chat. Shipped code takes no confirmation from those variables: a person's terminal, a command's public `--confirm` flag or a soft gate's `--confirm-override` is the only way. The hook reads what a line says, so it is not an OS sandbox: a script that runs the command itself is not caught. Presence-signed person steps (SPEC-PSS-v1) are the planned fix for that.

## Purpose and prerequisites

Use this topic when the current goal matches **copilot and surfaces**. Start in a repository that uses Singularity Flow unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Personalize SFlow replies and suggestions

In VS Code, run **Singularity Flow: Configure User Profile**, or set `singularityFlow.userName`.
SFlow uses this preferred name first, then the active repository's configured Git `user.name`.
If neither supplies a usable name, replies remain neutral. Names are never inferred from email,
login, the OS account or chat memory. Clear the profile name to return to the Git fallback.

The extension shares the name with shell skills through a bounded, private machine-local
`~/.singularity-flow/presentation-profile.json` preference. CLI children also receive the current
window's setting directly. Missing, corrupt or inaccessible preferences never block a Story.
There is no account lookup or network request for personalization, and no additional Copilot
command: the existing pause check returns the reply name. Replies and suggestion groups address
the user naturally, once per group, without adding their name to every bullet or command.

Presentation overlays are separate from retained phase/planning prompt bytes, approved artifacts,
Story snapshots, signed handles, tests and authorization. A display-name change does not stale
inputs or change the Git identity used for decisions. Paused SFlow emits no personalized
Copilot guidance and leaves ordinary Copilot requests alone.

## Use it from each surface

- **Shell:** `sflow about`, `sflow help`, `sflow plugin`. Use `sflow home --request "What is blocking this Story?" --json` to inspect the conversational plan. Run `singularity-flow about --help` for the exact forms supported by this build.
- **Copilot:** invoke `/sf-home`, `/sf-help`, `/sf-start`, or another explicit `/sf-*` skill. With the SFlow workflow agent selected and guidance not paused, ask naturally about the current work. With the default Agent, unrelated requests stay native.
- **Revision feedback files:** `/sf-revision-attachments` (or `/sflow-revision-attachments`) previews and registers verifiable local files against the selected Story/phase after explicit confirmation. In VS Code, `@sflow /attachments` accepts 1–5 genuine local file references, selects each whole file, and offers a separate confirmed registration button. `@sflow /attachments status` shows active/revoked set digests; `@sflow /attachments remove sha256:<SET>` reviews exclusion. An opaque Copilot chat upload without original bytes or a verified local reference returns `REV_CHAT_ATTACHMENT_UNAVAILABLE`; save it locally and provide its path. Registration only stages feedback evidence. Start an eligible guarded interval separately with `/sf-revise`, which previews the exact Candidate/criteria/attachment binding and requires the full plan digest. `@sflow /revise` runs read-only status/card inspection or prefills that skill; it never starts the interval itself. PDF/DOCX/images remain disabled until approved scanning and extraction exist.
- **VS Code:** open the Singularity Flow Navigator. The fixed destinations are **My Work**, **Stories**, **Story Analytics**, **Code Explainer**, **Reviews**, **Workspaces**, and **Configuration**. The context area identifies the workspace, repository, and confirmed active work. Stories lists the workspace catalog; viewing details is read-only, while **Switch to Story** uses the guarded attach flow. Story Analytics opens the read-only lifecycle report directly, showing phase progress, time, tokens, and cost when available. Code Explainer opens the read-only code and change explanation. Reviews separates phase decisions from proposal and visual-evidence review routes; unqueried queues have no invented counts. Configuration opens the existing Configuration Center directly. **Work tools** retains phase actions, artifacts, Goals, Epic Story plans, and **Understand changes**. **Help & diagnostics** and **Activity & logs** contain the specialist tools; Local Journal remains private local history, not evidence. Hover gives a small visual zoom, never a command popup; reduced-motion settings disable the zoom. Commands and Copilot equivalents remain in explicit Help and recovery screens. The sidebar follows the editor theme and does not independently decide lifecycle state.

### What an agent reads

A command run with `--for-agent`, or with `--json` when its output goes to a terminal (where a host agent runs it), starts its result with `act`: the state, the one thing to do now (`do`, with its Copilot, Shell and VS Code routes) and anything a person must answer or confirm first (`ask`). Every value comes from the engine's own fields. A result larger than 7,500 bytes is bounded: the complete result is written to `.sflow/out/` at the top of the checkout the command ran in, long texts such as the composed context as their own files (named like `phase-entry-5ec3d303.context.text.txt`), and the printed view keeps `act`, the fields that fit and `omittedFields`, each with its exact line range in `agentOutput.path`. Nothing is truncated. The folder is SFlow's own: one line in the clone's `.git/info/exclude` keeps it out of `git status`, commits and every clean-checkout check, and the team's `.gitignore` is never edited. A result's files are kept at least a day and removed whole, never while it may still be read. A result that cannot be written there (a full disk, a folder another program holds open) is still shown, with `agentOutput.retained: false` and why, never as a refusal of a command that ran. On Windows every JSON result is plain ASCII, other characters written as `\uXXXX`, so a PowerShell code page cannot garble a path. `SINGULARITY_FLOW_AGENT_OUTPUT_BYTES` changes the bound; `SINGULARITY_FLOW_AGENT_OUTPUT=full` prints the whole result. A route never drops a reviewed digest: where a confirmation carries `--confirm sha256:<DIGEST>` and its own skill would only preview it again, the Copilot route is `/sf-confirm <the exact command>`, which runs that confirmation once; the CLI refuses a digest that no longer matches. When the same result with something to do or confirm comes back a third time in a row for the same step, unchanged, `act.loop` says so and names the one thing that changes it, such as asking the person to confirm now; the count is kept on this computer only and accepts nothing.

A host can still show only part of a result, save it where the agent cannot open it, or return while the command is still running (VS Code's terminal tool does this for a long command such as `phase prepublish`, which runs the tests). So every `--for-agent` JSON command keeps its complete result, refusals included, on this computer for its checkout (the last five, outside the repository). `singularity-flow result last --wait --for-agent --json` waits until no command of the checkout is still running, then returns the newest kept result exactly as its command returned it, starting with `act`; `--command "phase prepublish"` picks the newest of one command. It is a read and never runs the command again. A command that ended without a result (interrupted or killed) is named, to run once more. Every Story skill's output rule says to run it instead of rerunning a command or pointing back to its own skill.

## Guided workflow

In Story intake, **Search branches → Exact match** filters by the complete, case-sensitive Git
branch name rather than partial names, Story IDs or titles. Clear the query to see all offered
branches. Filtering stays local and never selects a branch for you. The **Stories** list shows the
recorded creation date in UTC; hover for the full timestamp. Older Stories without that metadata
show **Not recorded**, not a commit or refresh date.

1. Ask naturally or read current state with `sflow home`, `sflow status`, or the relevant list/status form. The conversational layer selects a read planner only; it never turns prose directly into a lifecycle mutation.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Read-only orientation, inspection, and recovery diagnosis may run immediately. For Start, Continue, Generate, Submit, or Next, review the proposed action and its effects, then explicitly select it. Approval, rejection, cancellation, resets, and destructive operations require their exact `/sf-*` skill and ceremony.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.
6. In VS Code, use **Pinned shortcuts → Choose shortcuts**. Existing pins are preserved. Personas suggest pins without reordering the primary destinations. Launching a shortcut executes the original command; it does not bypass confirmation or authority checks.

## State and safety

These commands can change repository or machine-local state: `plugin`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Automatic Home invocation is not mutation consent. Raw developer prose is not retained in the conversational plan; only the deterministic intent and route are returned. VS Code Favorites store only stable menu IDs in personal global state; they never store lifecycle data or enter Git. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.
- If Copilot in VS Code says the chat has no terminal or command tool, look at the agent picker in the chat. `/clear` opens a new chat, and VS Code chooses that chat's agent itself, from its saved draft or `chat.newSession.defaultMode`, not from the chat you left. A typed `/sf-*` skill moves the chat to **Agent**; if your installed skills are older than that, choose **Agent** and run it again. An agent file with a terminal must list `execute` for VS Code to give it one, because VS Code does not read `bash`: `sflow doctor` names any that do not, and Upgrade / migrate SFlow updates the unedited packaged ones. If your organization has turned off agent mode (`chat.agent.enabled`), no Copilot chat can run a command: use **Singularity Flow: Continue Safely** or a terminal instead.
- If an agent says a result was saved to a file it cannot open, run the same command again with `--for-agent --json` and read `agentOutput.path`. Reading the host's saved copy with shell tools is refused in a Story turn. JSON read through a pipe or a file, as VS Code and scripts read it, is always whole.
- If ordinary language is ambiguous, choose from the displayed Home directions or invoke `/sf-home`; the router deliberately refuses to guess between mutations.
- If a favorite disappears after an upgrade, reopen **Choose favorites**. Unknown or retired menu IDs are discarded rather than guessed.

## Related topics

Continue with `sflow explain developer-home`, `sflow explain help-and-docs`, `sflow explain governed-execution`, `sflow explain revision-loop`, or `sflow explain revision-feedback-attachments`.

## The five-tool gateway

VS Code (Copilot agent mode) and any MCP host reach the same gateway through exactly five tools: `sflow_resolve` turns what the person said into one resolved operation, a bounded choice, a question or a refusal; `sflow_read` reads only a handle that resolution returned; `sflow_next` lists what is legal now; `sflow_explain` answers from cited documentation; and `sflow_run` carries out only a plan the person confirmed outside the conversation. A model can propose a broad goal and typed arguments; the kernel decides the operation, its legality and its plan.

Run `singularity-flow gateway serve --transport stdio` as a local MCP server. Its configuration holds no credentials. A plan runs only after the person confirms it in the MCP client's own prompt (elicitation); a client that cannot ask shows every plan and refuses to run it, and the explicit terminal command still works. In VS Code the confirmation is the editor's own dialog, and an exact confirmation asks you to type the record's ID. `singularity-flow gateway tools --json` prints the five schemas and their measured size; `singularity-flow gateway events` lists recent gateway calls on this machine, filtered by host, operation, outcome, reason, subject or correlation ID, without anything anyone typed.

While guidance is paused (`/sf-pause`), all five tools answer `gateway.copilot-paused` before they read anything, in VS Code and over MCP alike, so a tool call is no way around the pause. Read skills use the tools when the host offers them: `/sf-recommend`, `/sf-home` with no request and `/sf-advise` with no question call `sflow_resolve` with "what should I do next" and then `sflow_read` with the handle it returns, which is the read `singularity-flow recommend --json` makes. `/sf-docs` and `/sf-help` call `sflow_explain` with the question: it serves the text `singularity-flow explain --json` serves, up to 16,384 bytes. `/sf-progress` and `/sf-nextsteps` call `sflow_resolve` with "show story progress" or "show story next steps" (a Work ID goes in `arguments.workId`) and then `sflow_read` with its handle: the answer is what `progress --json` prints, or the actions, context boundary and pending list `nextsteps --for-agent` lists. Without the tools (Copilot CLI's plugin registers none), on a refusal, or when an answer lacks a field the skill reports, they run that command instead. `/sf-status` stays on its command, because the Story record it reads is much longer than one tool answer.

Both Copilot hosts move a tool result longer than about 8 KB out of the conversation, so no tool answer is longer than 7,500 bytes, the same bound as a CLI agent view. Both hosts check every answer last: one that fits is sent as it is. A longer Home or recommendation answer is sent as its tool view, which keeps every field those skills report. It leaves out the receipt and progress rail only the VS Code card draws, the repeated copies, each route's other spellings, and the optional and later lifecycle steps, which `data.guidance.moreActions` counts and `/sf-nextsteps` lists; `data.toolView` names what was left out. A long topic comes in parts: the first answer lists one read handle per further part in `data.part.read`, and the parts read together with `sflow_read`, in order, are the whole text. A Story read too long for one answer is refused with `gateway.answer-too-long`, and any other answer still too long with `gateway.tool-answer-too-long`; the skill then runs its command. A plan's run, and an answer that changed something, are always sent whole. In VS Code the routes an answer offers follow `singularityFlow.modelMode`, as the commands the window runs do. In a read skill's turn the Copilot guard refuses `sflow_run`; the other four tools pass.
