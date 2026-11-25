---
id: help-and-docs
title: Getting help
aliases:
  - help
  - explain
  - docs
questions:
  - How can I ask Singularity Flow a natural-language question?
  - What can sf-help answer?
  - Why does @sflow say Language model unavailable?
keywords:
  - natural language
  - cited answer
  - help intent
  - language model unavailable
commands:
  - nextsteps
  - doctor
  - about
  - help
  - explain
  - ask
related:
  - getting-started
  - nextsteps
version: 11
---
Every command supports `--help` (without executing). `sflow nextsteps` answers "what should I do here" from state; `sflow doctor` answers "why is my machine unhappy" with named fixes. Product questions in Copilot are answered from these packaged topics — grounded in the served text with the topic cited, never from model memory; questions with no matching topic say so and list the nearest topics. Judgment questions ("should I escalate?") are for `nextsteps` and the humans your pinned configuration names.

`/sf-help` accepts a topic ID or an ordinary question. The model-free router first classifies the
answer shape as concept, procedure, diagnosis, comparison, command discovery, or recovery. It then
matches only authored topic metadata and returns the cited topic bytes. Exact IDs and aliases win;
a weak match is refused and a close tie returns choices. This classification selects help content,
never a lifecycle operation. Questions about current blockers remain on the durable Home/readiness
path, and action-shaped prose still requires the normal explicit selection.

VS Code also contributes the explicit `@sflow` participant. Its `/help`, `/why`, `/how`, `/recover`,
and `/topics` routes use the same resolver and never call the chat model; `/explain` also remains
a reviewed-topic route in this increment. Declared zero-model adapters cover `/next`, `/status`, `/checks`, `/converge`, `/docs`, `/inputs`,
`/workflows`, `/approve`, `/submit`, `/publish`, `/continue`, and `/validate`. `/next` reads
`nextsteps`, `/checks` selects `precheck --quick`, and `/inputs` is an active-phase `--dry-run`.
`/approve [phase] [--work-id ID]` uses the native exact human approval review. `/submit` and
`/publish` confirm one hash-bound action with normal tests and gates; `/continue` lets the human
choose one legal model-free lifecycle action. They never auto-loop or turn prose into approval.
SFlow disables model invocation in their CLI environment. Copilot guidance and VS Code panels
show **VS Code (model-free): @sflow /…** only for supported commands. Install the new extension
and reload VS Code. See [the complete participant boundary](../CPT-CHAT-PARTICIPANT.md).

VS Code delivers an `@sflow` request only after it finds a chat model: Copilot signed in, or a
model picked in the chat model picker. `@sflow` never sends that model anything, but with none
available VS Code itself answers **Language model unavailable** and `@sflow` never runs. When no
chat model is registered, SFlow panels mark each **VS Code (model-free)** route as unavailable,
drop **Copy @sflow**, and Help Center says so. Use Help Center for the same reviewed answers, or
the Shell route for the action.

## Ask SFlow

Open **Ask SFlow** in the browser workspace or VS Code Navigator. Type to find a screen, or submit a question about the current checkout. Ask SFlow can show recorded blockers and resolve the exact published specification used by the current Story. Type-ahead uses local menu metadata.

- List local matches with `singularity-flow ask --suggest "spec studio"`.
- Inspect recorded blockers with `singularity-flow ask "What is blocking me?"`.
- Resolve a Story’s recorded spec revision with `singularity-flow ask "spec used for this Story"`.
- In the existing Copilot tool session, use `sflow_resolve` with utterance `ask sflow` and the question in `arguments.query`, then pass the returned read handle to `sflow_read`.

### Work and source history

Ask in the same browser workspace, VS Code Navigator, shell, or Copilot tool. The checkout identifies the repository. These are read-only requests.

| Question | What it reads |
| --- | --- |
| `history for story STORY-1` or `history for initiative INITIATIVE-1` | Retained events from the configured state ledger, including work whose branch has been deleted. |
| `currently completed stories` | The latest retained states that are complete. |
| `stories completed last week` | Work with a retained transition to complete during the period. |
| `initiatives with activity last week` | Work with a retained event during the period. |
| `story STORY-1 as of 2026-11-07 in UTC` | The latest state before the next local midnight, when the ledger holds enough history. |
| `commits from 2026-11-01 to 2026-11-07 in Asia/Kolkata on main` | Reachable commits filtered by committer timestamp from the exact revision resolved for `main`. |
| `compare main with release/v1` | The direct tree difference between the two resolved revisions. Add `patch src/app.js` to view a bounded patch in your own viewer or with `--for-person`. |

Both dates in a range are inclusive in the selected timezone. UTC is the default. A relative query uses the recorded query time and Monday as the start of the week. Author, integration, PR merge, deployment, and knowledge-time queries need separate evidence.

Use **Next page** to keep the original revisions and dates. In the shell, pass the issued token to `singularity-flow ask --cursor TOKEN`. On the Copilot tool, resolve `ask sflow` with `arguments.query` set to `continue` and the issued token in `arguments.cursor`. Missing records, shallow ancestry, and scan limits report partial or unavailable coverage. An exact zero is shown only when the available provider completed the requested read without gaps.

### Saved conversations and evidence

Ask SFlow in the browser and VS Code can save the displayed order, date filters, and exact source references. Choose **Resume saved conversation** to continue on the same machine in the same checkout. A phrase such as `the second result` selects the second item from the answer you saw. `Show that spec` opens the selected published revision. `Next page` and `also include the previous week` keep the pinned Git revision and timezone.

The local store is private to the user and checkout. A scope supports up to 16 saved conversations. Each expires 30 days after its last update, and expired records are removed when a new conversation is saved. It saves references and filters. Source text, questions, and generated explanations stay out of the conversation record. Use **Forget conversation** to remove its saved context. Source records stay with their owners.

**View evidence** rechecks the selected revision or record digest before opening it. The view identifies the source commit, state snapshot, or document revision. If the source has changed or the library withdrew a revision, Ask reports the evidence as unavailable and withholds its cached display details.

**Explain with Copilot** is an explicit action. It can send up to eight verified facts in one tool-free request and organize them by their evidence links. SFlow supplies the statements and keeps the underlying result unchanged. With models disabled or Copilot unavailable, the explanation uses the verified facts directly.

- Start a private shell conversation with `singularity-flow ask "commits last week in UTC on main" --remember --for-person`.
- Resume with `singularity-flow ask --resume --for-person`.
- Use the ID and revision returned by Ask to follow up with `singularity-flow ask "the second result" --conversation=ID --revision=N --for-person`.
- Add `--explain` in place of the question for an optional Copilot explanation, or use the evidence command returned with a result.
- In the Copilot gateway, `sessionAction: "query"` starts a saved context. For later actions, pass its `conversationId` and `contextRevision`. To reopen evidence, use `sessionAction: "evidence"`, `query: "evidence"` and the returned link ID as `target`. The gateway provides verified facts without launching a second model.

## Purpose and prerequisites

Use this topic when the current goal matches **help and docs**. Start in a repository that uses Singularity Flow unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow nextsteps`, `sflow doctor`, `sflow about`, `sflow help`, `sflow explain`. Quote a natural question as one argument, for example `sflow explain "What is project binding?"`. Add `--here` when the concept should be paired with the current Story snapshot. Run `singularity-flow nextsteps --help` for the exact forms supported by this build.
- **Copilot:** Type `@sflow` explicitly, then use a declared slash command such as `@sflow /why Why can’t I submit?`, `@sflow /next`, or `@sflow /checks`. Unknown free text shows participant help rather than using a model to route it. The existing `/sf-nextsteps`, `/sf-doctor`, `/sf-about`, and `/sf-help` skills remain the fallback on hosts without participants. Help relays bounded cited documentation and never mutates state.
- **VS Code:** open Singularity Flow **Help Center**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or the relevant list/status form.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

The commands mapped to this topic are read-only. They may inspect local files and Git state, but they do not advance lifecycle state or grant authority. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.
- If chat answers `@sflow` with **Language model unavailable**, VS Code has no chat model (Copilot is signed out or turned off). Sign in to Copilot or pick a model, or use Help Center and the Shell routes, which need none.

## Related topics

Continue with `sflow explain getting-started`, `sflow explain nextsteps`.
