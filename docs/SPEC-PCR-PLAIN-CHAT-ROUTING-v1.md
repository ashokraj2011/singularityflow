# Plain-chat routing (PCR) — v1: every prompt tracked, every change through an `/sf-` skill

Status: owner decisions recorded 2026-11-09; Copilot CLI probed in real runs the same day. P1 and P2 built the same
day, with owner decisions 11–15 from that build. P3 and P4 are next.

In every repository that uses SFlow, each prompt is tracked, a secret in a prompt is refused as far as the host
allows, and a change to the work goes through an `/sf-` skill turn, or is recorded as if it had. Each repository
chooses how strict that is. The guard travels with the repository, so it applies to anyone who opens it with
Copilot, not only to people who installed SFlow. Questions, reading and explaining stay free.

## Owner decisions (2026-11-09)

1. **The setting is the repository's own.** `policy.plainChatEdits`:
   - `refuse`: a plain chat's change is refused with the line to type;
   - `record`: it goes ahead and is tracked;
   - `allow`: today's behaviour.

   It sits on the repository's capability map. The repository's own setting is also written into its committed
   hook file, so it applies on a machine without SFlow (`[PCR:REQ-033]`).
2. **It applies everywhere SFlow is used.** That means every repository that uses SFlow, with or without a Story
   in progress, so that prompts are tracked and secrets are refused.
3. **Shell commands.** A plain chat may run the read-only set that read-only `/sf-` turns already use; any other
   command is a change.
4. **A line of context naming the route.** Yes, where a host lets a hook add one (see "What the hosts allow":
   Copilot CLI, through the prompt hook's `additionalContext`).
5. **Folding.** The same as `policy.plainChatSecrets`: a child capability may tighten its parent, never loosen it.
6. **The guard ships in the repository** (`.github/hooks/`), not in organisation policy.
7. **The design rule reverses.** scripts/check.mjs says: "No blanket lifecycle guard: discovery and file edits are
   restricted only during an explicit SFlow invocation." In a repository that uses SFlow, that no longer holds.

**Taken as recommended** (the owner asked for the build on 2026-11-09; any of them can still change):

8. **The default for a repository that has not chosen.** *Decided: `record`.* Everything is tracked and nothing
   is blocked until the repository chooses `refuse`. It keeps "nothing should get blocked" by default.
9. **Where tracked prompts live outside a Story.** Inside a Story they go into the Story's record, which is shared
   when the Story is pushed. Outside one: kept locally in the clone, or pushed to a shared `sflow/prompts`
   branch? *Decided: locally, for v1.* A shared branch puts every person's chats in the team's history, a larger
   privacy step to take on its own.
10. **A machine without SFlow.** The committed hook can't track prompts there, because it has no SFlow to call.
    Refuse changes with a line to install SFlow, unless the repository says `allow`? *Decided: yes.* Otherwise
    work there is the one kind that goes untracked.

**From the P1 and P2 build** (2026-11-09; the owner took each recommendation):

11. **A secret in the words typed after an `/sf-` skill refuses that turn's tools too,** as for a plain chat.
    Secrets are refused everywhere (decision 2), so `[PCR:REQ-017]` no longer leaves an `/sf-` turn exactly as
    today on this one point. *Decided: yes.*
12. **A plain prompt in a Story checkout joins the Story's "Asked for" even when it changed nothing,** marked
    "plain chat". It is shared when the Story is pushed, as the Story's record is. It needs accounting only when
    its turn changed something (`[PCR:REQ-012]`). *Decided: yes.*
13. **A prompt copied into the Story before its turn changed anything stays unmarked** when the turn later changes
    something. It is rare, and the prompt is still recorded. *Decided: accepted for v1.*
14. **A chat opened outside a repository that uses SFlow is not guarded when it changes one.** The plugin's
    launcher starts SFlow only for a session whose folder uses SFlow, and a host loads a repository's hook file
    only from the session's own folder, so P3 does not close it either. Closing it would start Node for every
    possible change in every repository on the machine, against `[PCR:REQ-015]`. *Decided: a known limit, said in
    the docs.*
15. **`singularity-flow prompts` is reached through `/sf-prompt-log`,** with one line added to that skill.
    *Decided: yes.*

## What the hosts allow

From real Copilot CLI runs, and from GitHub's Copilot CLI hooks pages and VS Code's hooks page (Preview, dated
2026-11-04), all on 2026-11-09. Where a real run and the docs disagree, the real run is what this spec relies on.

**Copilot CLI 1.0.107, real runs.** This used a repository hook file, a made-up token and an isolated home: 14 model
calls, 3.49 credits.
- **The prompt hook can reject a prompt.** `userPromptSubmitted` returning `{"decision":"block","reason":…}`
  stopped the turn with no model call and 0 credits.
  - The person saw the reason on stderr (`! <reason>`, exit 1). As JSON output it arrives as a `policy_blocked`
    warning.
  - The docs say a config-file hook's output is dropped; on 1.0.107 it is not.
- **The prompt hook can steer.**
  - Its `additionalContext` reached the model as a system-reminder block.
  - Its `modifiedPrompt` replaced what the model read, while the person's own message kept the original text.
- **`userPromptTransformed` can redact.** Its `modifiedTransformedPrompt` replaced the token with `[redacted]` in what
  the model received. `transformedPrompt` is a string with the CLI's own date and system-reminder wrappers, and a
  rewrite must keep them. A blocked prompt never reaches this hook.
- **The raw prompt stays in the CLI's own files.** Even when blocked or redacted, the token stays in the session's
  `events.jsonl`, in the hook inputs, and as the session's name. Those are the host's files, outside SFlow's reach.
- **Repository hooks need a trusted folder.**
  - In an untrusted folder the CLI skips `.github/hooks` with a warning and runs the model anyway, with no guard
    from that file.
  - The trust dialog does not mention hooks.
- **Plugin hooks do not need trust.** A plugin's hooks fired in an untrusted folder, where the repository's were
  skipped.
  - In a trusted folder both run, the repository's first.
  - A repository `preToolUse` deny was the last hook to run on that call: the plugin's `preToolUse` did not fire
    after it. That is an inference from one run.

**VS Code**, docs only. A real run needs the owner's sign-in in an isolated window.
- The page says "command-hook output is ignored for `userPromptSubmitted`." Until a real run says otherwise, VS Code
  can neither block a prompt nor steer from that hook.
- `userPromptTransformed` is not mentioned.
- **`preToolUse` is the guarantee on both hosts.**
  - `permissionDecision` is `allow`, `deny` or `ask`, with `permissionDecisionReason`.
  - "If any hook returns `"deny"`, the tool is blocked", whichever file it came from. In the real run, a
    repository hook's deny blocked both a shell write and `apply_patch`, the file never appeared, and the model
    passed on the reason without retrying.
  - A crash or a non-zero exit denies. A timeout always lets the call through.
  - VS Code reads the decision under `hookSpecificOutput` (SFlow answers both ways since e4dbdf690).
- **Where hooks come from.** Both hosts' Copilot harness reads:
  - the repository's `.github/hooks/*.json`;
  - `~/.copilot/hooks/`;
  - inline `hooks` in `.github/copilot/settings.json` and `.github/copilot/settings.local.json`;
  - another agent harness's settings file in the repository;
  - plugins.

  "When the same event appears in multiple sources, all hook entries from all sources are run."
- **Turning hooks off.**
  - A repository's settings file can say `disableAllHooks` (CLI). That skips every hook for that repository except
    organisation policy hooks, and a person's own uncommitted `settings.local.json` can say it too.
  - The docs do not say whether VS Code honours this, or whether VS Code asks before trusting a repository's hooks.
  - Where hooks are off, nothing here applies, and the lifecycle's own checks stay the backstop: departures, the
    dirty start, the conformance report.
- **`sessionStart`** could add context, but SFlow forbids it: no prompt injected at every session start. That stays.
- **SFlow's own hint.** On `/sf-` turns SFlow returns a top-level `additionalContext` line from the prompt hook
  (the off-PATH CLI hint). Copilot CLI reads that field from a repository hook, and from a plugin hook it very likely
  does too. VS Code's page says it is ignored there (`[PCR:REQ-041]`).

## What happens today (main f6aadf36e)

- **A plain prompt** (no `/sf-…` start and no `<skill-context name="sf-…">`) is native Copilot.
  - The prompt hook keeps nothing, adds nothing, and ends any earlier `/sf-` turn's contract (src/copilot-repository-boundary.mjs `recordTurn`).
  - Edits and ordinary commands go through in any repository, Story and step.
  - Only two things are refused: a person's own SFlow step, and secret files under `policy.plainChatSecrets`.
- **Later, SFlow sees only bytes.**
  - A plain change inside a planned file is recorded nowhere and is no departure: the "make the timeout 10s" case
    `[SCS:REQ-040]` closed for `/sf-code`, reopened by leaving the prefix off.
  - A pasted secret in a plain prompt reaches the model, and nothing notes it.
- **The launcher answers without starting Node** (100-180 ms) unless:
  - a turn is recorded on the machine;
  - the call names SFlow;
  - the call names a file that could hold secrets.
- **Two faults:**
  - A prompt hook that fails or times out leaves the previous `/sf-` turn's contract governing the plain turn.
  - SF Guard labels a plain prompt after an unclosed `/sf-` turn as that skill's continuation.

## Model

In a repository that uses SFlow (any branch, Story or not), with hooks on:

| | `refuse` | `record` | `allow` |
|---|---|---|---|
| Each prompt | tracked, redacted | tracked, redacted | tracked, redacted |
| A secret in a prompt | turn's tools refused; redacted for the model where the host allows | same | same |
| Reading, searching, explaining, read-only commands | free | free | free |
| An edit or a writing command | refused, with the line to type | goes ahead, tracked; a code step's approval waits for it | goes ahead |
| A person's own step, a secret file | refused, as today | refused, as today | refused, as today |
| Without SFlow on the machine | changes refused, with an install line (decision 10) | same | as today |

- A repository that does not use SFlow, or no repository at all, behaves exactly as today, and its calls start no
  Node.
- `/sf-pause` turns all of this off on that machine, except a person's own steps, as today.

## Requirements

### P1 Every prompt tracked, a secret refused `[PCR:REQ-001]`

- `[PCR:REQ-001]` **Where.** A repository that uses SFlow, by the same test the secrets guard uses
  (`usesSflow`):
  - `singularity/workflow.yml`, `capabilities.yml` or `environments.yml`;
  - SFlow's folder under `.git`;
  - an `sflow` or `sflow/config` ref.

  The guard decides from the call's own working directory or path, never from the chat's opening folder. It is
  reached only from a session whose folder uses SFlow (decision 14).
- `[PCR:REQ-002]` **Tracked.** Every prompt there, plain or `/sf-`, is recorded with the session, time, repository
  and, when a Story is in progress, its Story and step.
  - It is redacted and bounded exactly as `[SCS:REQ-040]` keeps typed text.
  - In a Story checkout it joins the Story's record: "Asked for" for a code step, as `/sf-code` text does, marked
    "plain chat".
  - Outside a Story it goes to the clone's local log, `<git dir>/singularity-flow/prompts/` (decision 9).
  - A plain prompt joins the Story's record even when it changed nothing (decision 12).
  - `singularity-flow prompts [--story ID]`, reached through `/sf-prompt-log` (decision 15), and a VS Code view
    show them.
  - A prompt is recorded once, whichever hook file ran first (`[PCR:REQ-031]`).
- `[PCR:REQ-003]` **A secret in a prompt.**
  - **What counts.** Found with the same rules as the redaction (token shapes, private keys, values of declared
    environment files).
  - **Copilot CLI.** The prompt is rejected before the model is called: `decision: "block"`, with the reason
    "SECRET_IN_PROMPT: this prompt held what looks like a <kind> and was not sent. Remove it and send it again."
    The CLI's own session log still holds the text; SFlow says so in the reason and in the topic page.
  - **VS Code**, unless a real run shows it can block. The prompt reaches the model, and the record keeps only the
    redacted form. Every tool call in that turn is refused with
    `SECRET_IN_PROMPT: the prompt held what looks like a <kind>; it reached the model, so rotate it. Nothing in this
    turn runs. Do not retry it`. The turn ends at the next prompt.
  - **Never blocking.** A false positive costs one turn: the person sends the prompt again without the value,
    or with `/sf-pause` if it was no secret.
- `[PCR:REQ-004]` **People are told.** Prompts in a repository that uses SFlow are recorded, and people know it.
  - VS Code shows it once per repository.
  - The repository's README section written by onboarding says it, and `doctor` says it.
  - Copilot CLI shows nothing in a chat, because no hook can.

### P2 Every change through a skill `[PCR:REQ-010]`

- `[PCR:REQ-010]` **Under `refuse`.** A plain turn's edit tools, and every shell command outside the read-only
  set, are refused. The read-only set is the one `read-only-review` turns already use (src/copilot-mutation-guard.mjs
  `readOnlyShell`, `READ_ONLY_GIT`). Reads, searches, SFlow's read commands and the `sflow_*` read tools stay free.
- `[PCR:REQ-011]` **The refusal gives the line to type,** with the person's words filled in from the session's
  local copy of the prompt. That copy is deleted at the next prompt.
  - In a code step: `/sf-code <WORK-ID> <what they asked>`.
  - In another step: `/sf-phase <WORK-ID> …`.
  - With no Story in progress: `/sf-start …`, or the repository's quick-fix route when it has one.
  - Code: `PLAIN_CHAT_CHANGE_REFUSED`. The refusal ends with `Do not retry it`.
- `[PCR:REQ-012]` **Under `record`.** The change goes ahead, and the prompt is already tracked (`[PCR:REQ-002]`).
  In a code step it must be accounted for before approval (`[SCS:REQ-042]`).
- `[PCR:REQ-013]` **The setting.** `policy.plainChatEdits`: `refuse`, `record` or `allow`. The default is
  decision 8.
  - It folds like `policy.plainChatSecrets`.
  - It changes the same ways:
    - `capability plain-chat <ID> --edits …`;
    - `--plain-chat-edits` on `capability set|edit`;
    - **Changes in plain chats** on the capability page;
    - a reviewed proposal where `sflow/config` exists.
  - The capability that owns the changed path decides.
  - It reads the approved map on this machine, with no network, and only for a call it would refuse. A map that
    cannot be read keeps the repository's own setting.
- `[PCR:REQ-014]` **Answered inside the hook's time.** A host lets a call through when its hook times out (10 s).
  - So the guard decides from the repository marker, the session record and the Story's local state alone: no
    network, no Git subprocess, no full Story load.
  - Its time is in the performance budget.
- `[PCR:REQ-015]` **The launcher stays fast.**
  - A repository that uses SFlow is recognised by the committed hook file itself (P3). The plugin's launcher keeps
    its name test for every other call.
  - A call in a repository that does not use SFlow costs nothing new.
- `[PCR:REQ-016]` **A stale turn never governs a plain one.** The launcher removes the session's turn record before
  it starts Node for the prompt hook. A skill turn writes its record again, as today.
- `[PCR:REQ-017]` **Unchanged.**
  - `/sf-pause` turns this off, as it turns off the secrets check.
  - A failure of SFlow's own check lets the call through.
  - An `/sf-` turn is governed as today, except that a secret in the words typed after the skill refuses that
    turn's tools (decision 11).

### P3 The repository carries the guard `[PCR:REQ-030]`

- `[PCR:REQ-030]` **The hook file.** A repository that uses SFlow commits:
  - `.github/hooks/sflow.json` (`version: 1`), with the same seven events the plugin uses;
  - two launchers, `.github/hooks/sflow-hook.sh` and `.ps1`.

  Onboarding writes them, and `doctor` repairs them, as a reviewed change like any other.
- `[PCR:REQ-031]` **Nothing runs twice, and the plugin is the guard that needs no trust.**
  - Plugin hooks run in untrusted folders, and repository hooks do not. So where the SFlow plugin is installed, it
    does the work, and the repository launchers answer `{}`. SFlow's installation leaves a marker they read without
    Node.
  - Where it is not installed, the repository's hooks are the guard.
  - Each event is handled once.
- `[PCR:REQ-032]` **Without SFlow on the machine** (decision 10).
  - The repository launchers, in shell or PowerShell only, refuse an edit or a writing command with an install
    line, unless the repository's setting is `allow`.
  - They also refuse the secret file names the plugin launcher already tests.
  - Reading stays free.
  - They never crash: a host denies on a crash, so every unexpected error answers `{}`, and only the deliberate
    refusals deny. Tested on bash and pwsh.
- `[PCR:REQ-033]` **The file carries the repository's setting.** The launcher's arguments hold the repository's own
  `policy.plainChatEdits`, so the fallback knows it without SFlow. Changing the setting rewrites the file in the same
  reviewed change.
- `[PCR:REQ-034]` **Hooks turned off are visible.** `doctor` and the VS Code status say when this repository's
  hooks would not run:
  - a folder Copilot CLI does not trust, where its repository hooks are skipped;
  - `disableAllHooks` in its settings files;
  - a missing or changed hook file;
  - the plugin present but the repository hook absent.

### P4 Steering and records `[PCR:REQ-040]`

- `[PCR:REQ-040]` **A line of context (Copilot CLI).** Through the prompt hook's `additionalContext`, a plain prompt in
  a repository that uses SFlow gets one line, for example: "QF-1 is at Code. To change it, the person types
  /sf-code QF-1 …; answer questions freely."
  - It uses the existing prompt hook, so no event is added to the closed hook map.
  - The line names the route, and never tells the agent to run a skill or an SFlow command for the person.
  - VS Code gets no line: no hook there can add one.
- `[PCR:REQ-041]` **SFlow's existing hint.** Confirm with a plugin hook what the repository-hook run showed: Copilot CLI
  reads the prompt hook's `additionalContext`. Check VS Code in its real run. Where a host does not read it, the
  skill's own text carries the hint.
- `[PCR:REQ-042]` **SF Guard agrees with the guard.** A plain prompt after an unclosed `/sf-` turn is labelled a
  plain-chat turn.
- `[PCR:REQ-043]` **The docs say what the plugin does.**
  - README.md and HELP.md, which still say the plugin never refuses a tool, are corrected.
  - A topic page explains, per setting:
    - what is tracked;
    - what is refused and why;
    - pause;
    - hooks being off.

## Constraints

- **The closed hook map in scripts/check.mjs** keeps its seven events: blocking, steering and recording all use the
  existing prompt hook. It gains a check of the repository hook file. `sessionStart` stays forbidden.
- **No workflow gains a step.** Story records gain only "plain chat" marks on "Asked for" entries.
- **Recorded prompts are redacted before they are written.** The local log never leaves the clone (decision 9).
  Never print or copy a found secret: neither the refusal nor the record carries the value.
- **Approvals, decisions and person's steps are unchanged:** still people only.

## Not in scope

- Rewriting a person's prompt, or choosing a skill for them.
- `userPromptTransformed` and any other new hook event. Blocking makes redaction unnecessary in Copilot CLI.
- Organisation policy hooks (`policy.d`).
- A change made from a chat opened outside a repository that uses SFlow (decision 14).
- Hosts other than VS Code Copilot Chat and Copilot CLI. IntelliJ is parked.

## Order and size

1. **P1 and P2 together.** Tracking, secrets in prompts, the change guard, the setting, the stale-turn fix.
2. **P3.** The repository hook file and its launchers, the step-aside, the fallback.
3. **P4.** The context line and the hint check, then docs.

Everything up to a real chat is checked with each host's payloads and no model. The owner approved paid runs
(2026-11-09), and the Copilot CLI probes above are done. Still to run:
- the same checks with SFlow's plugin hook rather than a repository file;
- VS Code, which needs the owner's sign-in in an isolated window: does it load `.github/hooks/sflow.json`, and can
  its prompt hook block or steer?

## Acceptance

- **`refuse`, Story QF-1 at Code.** A plain "make the timeout 10s":
  - is tracked;
  - can read `src/retry.js` and run `git diff`;
  - is refused when it edits the file or runs `npm test`, with "type /sf-code QF-1 make the timeout 10s".
- **`record`.** The same edit goes ahead. The card shows "Asked for: make the timeout 10s (plain chat)", and Code's
  approval waits until it is accounted for.
- **No Story.** In a repository that uses SFlow, a plain prompt is in the local prompt log. Under `refuse`, its edit
  is refused with the start line.
- **A secret.** A prompt holding a made-up token is recorded as `[redacted]`.
  - In Copilot CLI, it is rejected before any model call, with the reason shown.
  - In VS Code, its turn's tool calls are refused with `SECRET_IN_PROMPT` and the advice to rotate.
- **No SFlow on the machine.** The repository's hook file refuses an edit with the install line, and reading works.
- **Elsewhere.** A repository that does not use SFlow behaves as today, and starts no Node.
