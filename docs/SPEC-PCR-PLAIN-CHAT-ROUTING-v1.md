# Plain-chat routing (PCR) — v1: work on a Story goes through an `/sf-` skill

Status: proposed 2026-11-09. Nothing is built. The owner decides the questions below first.

In a checkout where a Story is in progress, a change to its work happens in an `/sf-` skill turn, or it is
recorded as if it had. Questions, reading and explaining stay free in any chat. A repository with no Story
in progress, a repository that does not use SFlow, and a paused machine behave exactly as today.

## Owner decisions

My recommendation is in brackets.

1. **The default for a plain chat's change in a Story checkout.**
   - `refuse`: the edit or writing command is refused, and the person is told the line to type.
   - `record`: it goes ahead, and what was asked is recorded and must be accounted for before approval.
   - `allow`: today's behaviour.

   *[`refuse`. It is the only one that makes sure the work flows through a skill. Teams that want nothing
   blocked set `record` on their capability.]*

   This stops a plain chat's edit, so it is a deliberate exception to "nothing should get blocked". The
   refusal never loses work: nothing has been written yet, and the person's words come back to them as the line to type.
2. **Where it applies.** Only a checkout with a Story in progress (any step), or every repository that uses SFlow?
   *[Only a checkout with a Story in progress. Elsewhere there is no step for a skill to run.]*
3. **Shell commands in a plain chat.** Hold a plain turn to the read-only rules a read-only `/sf-` turn already
   uses (reads, searches, `git status|log|diff|show`, …), and treat any other command as a change?
   *[Yes. A test run or a build in a plain chat would be refused under `refuse`. "Run the tests" belongs to
   `/sf-code` or `/sf-test`, which record the run.]*
4. **The context line.** Should the prompt hook add one line to the model's context, naming the Story, its
   step and the skill to use, so the agent can say so before it tries an edit? *[Yes, in VS Code. Copilot CLI
   ignores a plugin's prompt-hook output (see "What the hosts allow"), so there the refusal alone steers.]*
5. **Can a child capability loosen its parent?** *[No, the same one-way folding as `policy.plainChatSecrets`.
   A child may tighten.]*
6. **Should the guard also travel with the repository or the organisation?** Copilot CLI loads hooks from a
   repository's `.github/hooks/*.json` and from organisation policy (`/etc/github-copilot/policy.d/*.json`) as
   well as from plugins. Either would reach someone who never installed SFlow. *[Not in v1. Such a hook has no
   SFlow runtime to call on that machine, and a command hook that errors denies every tool call. The plugin
   stays the way SFlow reaches a chat. `doctor` and the VS Code status can say when it is missing.]*
7. **This reverses a stated design rule.** scripts/check.mjs says: "No blanket lifecycle guard: discovery and
   file edits are restricted only during an explicit SFlow invocation." PCR restricts a plain chat's changes in
   a governed checkout. The closed map of hook events stays as it is: no new event and no `sessionStart`. Only
   the rule's words and what `boundary-guard` does change. *[Accept, for governed checkouts only.]*

## What happens today (main 9a2971879)

A prompt with no `/sf-` skill is native Copilot. The prompt hook keeps nothing. The agent's edits and
ordinary commands go through in any Story and any step.

- **The prompt hook** (`userPromptSubmitted` → `boundary-turn`).
  - `explicitSflowSkill` counts a turn only when the prompt starts with `/sf-…` or `/sflow-…`, or carries
    host-expanded `<skill-context name="sf-…">` (src/copilot-repository-boundary.mjs).
  - For any other prompt, `recordTurn` deletes the session's turn record and mutation record, then returns
    `{}`. An earlier `/sf-code` turn's permissions therefore end at the plain prompt.
  - Nothing is recorded in "Asked for", which keeps only `/sf-code` and `/sf-phase` text (src/asked-for.mjs).
  - Nothing is added to the model's context.
- **The tool guard** (`preToolUse` → `boundary-guard`). With no turn record, `repositoryToolGuard` runs
  `plainChatGuard`, which refuses only two things:
  - **A person's own step:** `approve`, `reject`, `decisions record` and the rest of
    src/person-step-catalog.mjs. The person is told the command for their own terminal.
  - **Secret files:** under `policy.plainChatSecrets` (docs/SPEC-ENVIRONMENT-FILES-v2.md, "Plain chats"),
    unless paused.

  An edit to `src/retry.js`, `npm test` or `sed -i` goes through with no message, in a code step, another
  step, with no Story, or paused.
- **Later.** SFlow sees only the changed bytes.
  - In a code step with an open generation, a planned file publishes as if `/sf-code` had changed it.
  - A file outside a required plan becomes a departure at the agent's prepublish, or refuses a person's
    publication.
  - With no open generation, `phase begin` refuses the dirty tree.
  - Another step refuses source changes at prepublish and submission.
- **The gap this leaves.** A plain prompt that changes behaviour inside a planned file is recorded nowhere
  and is no departure. It is the "make the timeout 10s" case `[SCS:REQ-040]` closed for `/sf-code`, reopened
  by leaving the prefix off. Only the conformance report could catch it.
- **The launcher.** It answers a tool call without starting Node (100-180 ms) unless:
  - a turn is recorded on the machine;
  - the call names SFlow;
  - the call names a file that could hold secrets (plugin/hook-launcher.sh, .ps1).

Two smaller faults found while reading:
- If the prompt hook fails or times out (10 s), the previous `/sf-` turn's record survives, and its contract
  governs the plain turn's tools.
- SF Guard labels a plain prompt that follows an unclosed `/sf-` turn as that skill's continuation, though the
  guard has already dropped that turn's contract.

## What the hosts allow

From GitHub's Copilot CLI hooks pages (use-hooks, hooks reference, hooks concepts), read 2026-11-09. Where they
are unclear, it is said.

- **`userPromptSubmitted` cannot steer in Copilot CLI.** Its only documented output, `modifiedPrompt`, "is honored
  only by SDK programmatic hooks", and a config-file or plugin hook's output is dropped. No block field and no
  `additionalContext` are documented for it.
  - VS Code reads a prompt hook's top-level context (test/copilot-search-exposure.test.mjs).
  - So recording a plain prompt works on both hosts, and steering it works only in VS Code.
  - `userPromptTransformed` (CLI) may rewrite what the model sees, but it is a new event outside the closed
    hook map, and nobody has checked whether a plugin may use it. It is left out of v1.
- **`preToolUse` is the guarantee on both hosts.**
  - `permissionDecision` takes `allow`, `deny` or `ask`, and a deny carries `permissionDecisionReason`. Exit
    code 2 also denies.
  - The docs do not say whether the reason reaches the model. The real runs of 2026-11-06 showed the agent
    reading and relaying the guard's refusals on both hosts.
  - VS Code reads the decision under `hookSpecificOutput`, which SFlow has answered with since e4dbdf690.
- **A timeout lets the call through,** for every event, `preToolUse` included. The plugin gives each hook
  10 seconds (`timeoutSec`). A command hook that errors denies the call. SFlow's launcher already does that on
  purpose when its runtime cannot load.
- **`sessionStart` could add context** (`additionalContext` is the only field it consumes), but SFlow forbids it:
  scripts/check.mjs refuses a plugin that "inject[s] a model prompt at every session start". That stays.
- **Hooks can be off.** `disableAllHooks`, a host without hooks, or IntelliJ (no guard). Where no hook runs,
  nothing here applies. The lifecycle's own checks stay the backstop: departures at prepublish, the dirty start,
  the conformance report.
- **`permissionRequest`** (CLI only) can stop the agent with `interrupt`, but it fires only when the CLI asks the
  person for permission, so it cannot carry a guarantee. Not used.

## Model

| In a checkout where… | A plain chat may | A plain chat's change |
|---|---|---|
| no Story is in progress, or the repository does not use SFlow | everything, as today | as today |
| a Story is in progress, policy `refuse` | read, search, explain, read-only commands | refused, with the line to type |
| a Story is in progress, policy `record` | everything | goes ahead; the prompt is recorded as "Asked for", and the step's approval waits until it is accounted for |
| a Story is in progress, policy `allow` | everything, as today | as today |
| the machine is paused (`/sf-pause`) | everything, as today | as today |

A person's own steps and secret files are refused in every row, as today. Pause leaves secret files free, as today.

## Requirements

### P1 Plain changes in a Story checkout `[PCR:REQ-001]`

- `[PCR:REQ-001]` **A governed checkout.** A checkout whose Story is in progress is governed. The tool guard
  decides from the file or command's working directory, never from the chat's opening folder: a chat can touch
  several repositories.
- `[PCR:REQ-002]` **The launcher stays fast.** A Story checkout writes a small marker into the machine's
  `copilot-boundaries` folder, naming its root and its current step's kind. The launchers start Node for a call
  whose path or working directory falls under a marked root, by comparing strings with no Git, and answer every
  other call as today.
  - The marker is refreshed when the step changes, and removed when the Story ends, leaves the checkout, or is set
    aside.
  - A stale marker costs one Node start, never a wrong refusal: Node checks the Story itself.
  - A call that falls under no marked root costs nothing new.
- `[PCR:REQ-003]` **Under `refuse`.** In a governed checkout, a plain turn's edit tools and every shell command
  outside the read-only set are refused. The read-only set is the one `read-only-review` turns already use
  (src/copilot-mutation-guard.mjs `readOnlyShell`, `READ_ONLY_GIT`). Reads, searches, SFlow's read commands and
  the `sflow_*` read tools stay free.
- `[PCR:REQ-004]` **The refusal gives the line to type.** It names the Story and the step. It suggests
  `/sf-code <WORK-ID> <what they asked>` in a code step, or `/sf-phase <WORK-ID> …` in another step, with the
  person's words filled in.
  - The prompt hook keeps the plain prompt, redacted and bounded as `[SCS:REQ-040]` keeps typed text, in the
    session's local record only.
  - The prompt is never written into the Story. It is deleted at the next prompt.
  - Code: `PLAIN_CHAT_CHANGE_REFUSED`. The refusal ends with `Do not retry it`, like the guard's other refusals,
    so the agent relays it instead of looking for a way round.
- `[PCR:REQ-005]` **Under `record`.** The change goes ahead.
  - In a code step, the plain prompt is recorded as "Asked for" exactly as `/sf-code` text is (`[SCS:REQ-041]`):
    redacted, bounded, copied into the Story at the next prepublish, and accounted for before approval
    (`[SCS:REQ-042]`).
  - In another step it is recorded and shown to the step's approvers, as `/sf-phase` text is.
  - Each record says it came from a plain chat.
- `[PCR:REQ-006]` **The setting.** `policy.plainChatEdits` on a capability: `refuse`, `record` or `allow`
  (owner decision 1 picks the default). It folds one way (owner decision 5).
  - It changes as `policy.plainChatSecrets` does:
    - `capability plain-chat <ID> --edits refuse|record|allow|inherit`;
    - `--plain-chat-edits` on `capability set|edit`;
    - **Changes in plain chats** on the capability page in VS Code;
    - a reviewed proposal where `sflow/config` exists.
  - `capability show` says which applies to a path.
  - The capability that owns the changed path decides.
  - It reads the approved map on this machine, with no network, and only for a call it would refuse. A map
    that cannot be read leaves `refuse` standing.
- `[PCR:REQ-007]` **What stays free.**
  - `/sf-pause` turns all of this off, as it turns off the secrets check.
  - A failure of the check itself lets the call through. A plain chat is someone's ordinary work, and the
    launcher already refuses when the runtime cannot load.
  - An `/sf-` turn is unchanged.
- `[PCR:REQ-008]` **A stale turn never governs a plain one.** The launcher removes the session's turn record
  before it starts Node for `boundary-turn`, so a failed or timed-out prompt hook leaves no earlier contract in
  force. A skill turn writes its record again as today.
- `[PCR:REQ-009]` **Answered inside the hook's time.** A host lets a call through when its hook times out
  (10 s). So the guard decides from the marker and the Story's local state alone: no network, no Git
  subprocess, no full Story load. Its time is measured in the performance budget, as the secrets guard's is.

### P2 Steering before the agent tries `[PCR:REQ-010]`

- `[PCR:REQ-010]` **One line of context, in VS Code.** In a governed checkout, a plain prompt's hook adds one
  line, for example: "QF-1 is at Code. To change it, the person types /sf-code QF-1 …; answer questions freely."
  - VS Code reads a prompt hook's top-level context.
  - Copilot CLI drops a plugin's prompt-hook output, so there the refusal in `[PCR:REQ-003]` is the only steer.
  - The line only saves a refused attempt; it is never the guarantee.
- `[PCR:REQ-011]` **The line is no instruction to act.** It names the route. It never tells the agent to run a
  skill or an SFlow command on the person's behalf.

### P3 Records and docs `[PCR:REQ-020]`

- `[PCR:REQ-020]` **SF Guard agrees with the guard.** A plain prompt after an unclosed `/sf-` turn is labelled
  a plain-chat turn, not that skill's continuation.
- `[PCR:REQ-021]` **The docs say what the plugin does.**
  - README.md and HELP.md still say the plugin never refuses a tool. They are corrected.
  - A topic page explains plain chats in a Story checkout: what is free, what is refused, the setting, and pause.

## Hosts

VS Code Copilot Chat and Copilot CLI first; both read the guard's refusal (`hookSpecificOutput` and top level,
e4dbdf690). IntelliJ runs no guard and is parked.

## Constraints

- The closed hook map in scripts/check.mjs stays: the same seven events, no `sessionStart`. The rule's comment
  is reworded for governed checkouts (owner decision 7).
- No workflow gains a step. No Story record changes shape, except that "Asked for" entries say they came from a
  plain chat (`[PCR:REQ-005]`).
- The refusal and the context line never carry the prompt's secrets: the same redaction as `[SCS:REQ-040]`.
- The launchers' name test for secret files is unchanged. A call that touches no governed checkout pays nothing new.
- Approvals, decisions and person's steps are unchanged: still people only, in their own terminal or on the card.

## Not in scope

- Choosing a skill for the person or rewriting their prompt. The hook names the route; the person types it.
- Plain chats outside a Story checkout.
- Hosts other than VS Code Copilot Chat and Copilot CLI.
- Hooks shipped in a repository's `.github/hooks/` or in organisation policy (owner decision 6).
- `userPromptTransformed` and other new hook events.

## Order and size

1. **P1.** It is the guarantee and closes the drift gap: guard, launcher marker, setting, stale-turn fix. About
   the size of the plain-chat secrets work (9386600b7).
2. **P2.** It is small once P1 marks the checkout.
3. **P3.** Docs, plus the SF Guard label.

Each part is checked in a real isolated VS Code and on Copilot CLI. A plain prompt in a real chat is a model call,
so that check needs the owner's yes for a paid run. Everything up to it is checked with the hosts' payloads and no
model.

## Acceptance

- **`refuse`:** in a checkout where QF-1 is at Code, a plain "make the timeout 10s":
  - can read `src/retry.js` and run `git diff`;
  - is refused when it edits the file or runs `npm test`, with "type /sf-code QF-1 make the timeout 10s";
  - after `/sf-pause`, the edit goes through.
- **`record`:** the same edit goes through, the card shows "Asked for: make the timeout 10s (plain chat)", and
  Code's approval waits until it is accounted for.
- **Elsewhere:** a repository with no Story in progress behaves exactly as today, and its tool calls start no Node.
- **Stale turn:** a prompt hook that times out after an `/sf-code` turn leaves the next plain turn under these rules,
  not under `/sf-code`'s contract.
