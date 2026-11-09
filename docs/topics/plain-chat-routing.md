---
id: plain-chat-routing
title: Plain chats in a repository that uses SFlow
aliases:
  - plain-chat
  - plain-chat-edits
  - kept-prompts
  - repository-hooks
related:
  - capability-management
  - environment-bindings
  - approvals
commands:
  - prompts
version: 1
---
In a repository that uses SFlow, Copilot's hooks keep every prompt, refuse a prompt that holds what looks like a secret, and send a chat's changes through an `/sf-` skill as far as the repository chooses. Questions, reading and explaining stay free. The repository's setting is `policy.plainChatEdits` on its capability map: `refuse`, `record` (the default) or `allow`.

## What happens under each setting

| | `refuse` | `record` | `allow` |
|---|---|---|---|
| Each prompt | kept, secrets taken out | kept, secrets taken out | kept, secrets taken out |
| A secret in a prompt | refused | refused | refused |
| Reading, searching, `git status`, `git diff`, `git log`, `ls`, SFlow's own reads | free | free | free |
| An edit, or any other command | refused, with the `/sf-` line to type | goes ahead; a code step's approval waits for its prompt | goes ahead |
| A person's own SFlow step, a file that holds secrets | refused | refused | refused |
| On a machine without SFlow | changes refused, with the line to install it | changes refused, with the line to install it | goes ahead |

**What is kept.** Each prompt, plain or `/sf-`, with its session (by a key, never its ID), time and repository, and the Story and step the checkout holds. Secrets are taken out before anything is written: token shapes, private keys, and the values of the repository's declared environment files. In a Story checkout a plain prompt joins the Story's "Asked for", marked plain chat, and is shared when the Story is pushed; it waits to be accounted for only when its turn changed something. Outside a Story it goes to the clone's own log, `<Git directory>/singularity-flow/prompts/`, which never leaves the clone. `singularity-flow prompts [--story ID]`, `/sf-prompt-log chats` and **Singularity Flow: Show Kept Copilot Prompts** show it.

**What is refused, and why.** A prompt holding what looks like a secret: Copilot CLI never sends it to the model, and in VS Code, which sends it on, nothing in that turn runs and the advice is to rotate it. Under `refuse`, a plain chat's edit or writing command, so the change goes through the step that records and reviews it; the refusal gives the line to type, such as `/sf-code QF-1 make the timeout 10s`. Copilot CLI also gets one line of context with each plain prompt naming that route; it never asks the agent to run a skill or a command.

**Pause.** `/sf-pause` turns all of this off on your own machine, except a person's own steps; `/sf-pause off` turns it back on.

## The repository carries the guard

`singularity-flow init` writes `.github/hooks/sflow.json` with the same seven events as SFlow's plugin, two launchers (`sflow-hook.sh`, `sflow-hook.ps1`) and a README that tells anyone who opens the repository that their prompts are kept. Commit them like any other change. The file carries the repository's own `policy.plainChatEdits`; changing it with `capability set --plain-chat-edits` rewrites the file in the same change, and `singularity-flow doctor --repair-hooks` writes all of them again.

- Where SFlow's plugin is installed, the plugin guards, so the repository's launchers step aside and each event is handled once.
- Where SFlow is installed without its plugin, the launchers hand each event to SFlow.
- Where SFlow is not installed, the launchers refuse an edit or a writing command with the line to install it, unless the setting is `allow`, and refuse a file named to stay on a laptop such as `.env`. Reading stays free. Anything unexpected lets the call through.

## When the hooks do not run

`singularity-flow doctor` says when this repository's hooks would not run:

- Copilot CLI skips a repository's hooks in a folder it does not trust. SFlow's plugin needs no trust and still guards.
- `disableAllHooks` in `.github/copilot/settings.json`, or in a person's own `settings.local.json`, turns every hook off, the plugin's too.
- The hook file is missing or differs from what SFlow writes for the setting.
- SFlow's plugin is installed but the repository has no hook file, so nothing guards a chat on a machine without SFlow.

Where hooks are off, nothing here applies, and the lifecycle's own checks stay the backstop.

**A known limit.** A chat opened outside a repository that uses SFlow is not guarded when it changes files in one: a host loads a repository's hooks only from the folder a chat was opened in, and SFlow's plugin starts its guard only for a session whose folder uses SFlow.
