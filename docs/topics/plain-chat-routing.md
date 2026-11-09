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
version: 2
---
In a repository that uses SFlow, Copilot's hooks keep every prompt, refuse a prompt that holds what looks like a secret, and send a chat's changes through an `/sf-` skill as far as the repository chooses. Questions, reading and explaining stay free. The repository's setting is `policy.plainChatEdits` on its capability map: `refuse`, `record` (the default) or `allow`.

## Purpose and prerequisites

Use this topic to choose what a Copilot chat with no `/sf-` command may change in your repository, and to see what is kept of what people ask. It applies wherever SFlow is used: a repository with `singularity/workflow.yml`, `capabilities.yml` or `environments.yml`, SFlow's folder under `.git`, or an `sflow` or `sflow/config` ref. Copilot CLI and VS Code run SFlow's plugin hooks; the repository also carries its own (`.github/hooks/`) for a machine without the plugin.

## Use it from each surface

- **Shell:** `singularity-flow capability plain-chat <ID> --edits refuse|record|allow|inherit` proposes the setting for review where `sflow/config` exists; `singularity-flow capability set <ID> --plain-chat-edits ...` changes a working-tree map and rewrites `.github/hooks/sflow.json` in the same change. `singularity-flow prompts [--story ID]` shows the kept prompts. `singularity-flow doctor` says whether the repository's hooks would run, and `singularity-flow doctor --repair-hooks` writes them again.
- **Copilot:** `/sf-prompt-log chats` shows the kept prompts. A refusal in a plain chat gives the line to type, such as `/sf-code QF-1 make the timeout 10s`; Copilot CLI also gets one line of context naming that route with each plain prompt.
- **VS Code:** **Changes in plain chats** on the capability's page sets it; **Singularity Flow: Show Kept Copilot Prompts** shows the kept prompts. VS Code says once per repository that prompts are kept, and its status bar shows **No repository hooks** or **Copilot hooks off** while either holds; clicking it opens Diagnostics.

## Guided workflow

| | `refuse` | `record` | `allow` |
|---|---|---|---|
| Each prompt | kept, secrets taken out | kept, secrets taken out | kept, secrets taken out |
| A secret in a prompt | refused | refused | refused |
| Reading, searching, `git status`, `git diff`, `git log`, `ls`, SFlow's own reads | free | free | free |
| An edit, or any other command | refused, with the `/sf-` line to type | goes ahead; a code step's approval waits for its prompt | goes ahead |
| A person's own SFlow step, a file that holds secrets | refused | refused | refused |
| On a machine without SFlow | changes refused, with the line to install it | changes refused, with the line to install it | goes ahead |

1. Choose the setting on the capability that owns the paths; a child may tighten its parent, never loosen it.
2. Commit `.github/hooks/` with the map: `singularity-flow init` wrote it, and changing the setting rewrites `sflow.json`.
3. Under `record`, account for each plain chat's change in the next `/sf-code` turn before the code step is approved, as you do for words typed after `/sf-code`.

**What is kept.** Each prompt, plain or `/sf-`, with its session (by a key, never its ID), time and repository, and the Story and step the checkout holds. Secrets are taken out before anything is written: token shapes, private keys, and the values of the repository's declared environment files. In a Story checkout a plain prompt joins the Story's "Asked for", marked plain chat, and is shared when the Story is pushed; it waits to be accounted for only when its turn changed something. Outside a Story it goes to the clone's own log, `<Git directory>/singularity-flow/prompts/`, which never leaves the clone.

**What is refused, and why.** A prompt holding what looks like a secret: Copilot CLI never sends it to the model, and in VS Code, which sends it on, nothing in that turn runs and the advice is to rotate it. Under `refuse`, a plain chat's edit or writing command, so the change goes through the step that records and reviews it.

## State and safety

The repository's hooks are `.github/hooks/sflow.json` (the same seven events as SFlow's plugin), `sflow-hook.sh`, `sflow-hook.ps1` and a README telling anyone who opens the repository that their prompts are kept. The file carries the repository's own setting.

- Where SFlow's plugin is installed, the plugin guards, so the repository's launchers step aside and each event is handled once.
- Where SFlow is installed without its plugin, the launchers hand each event to SFlow.
- Where SFlow is not installed, the launchers refuse an edit or a writing command with the line to install it, unless the setting is `allow`, and refuse a file named to stay on a laptop such as `.env`. Reading stays free. Anything unexpected lets the call through.

**Pause.** `/sf-pause` turns all of this off on your own machine, except a person's own steps; `/sf-pause off` turns it back on. People still make every approval and decision; nothing here answers for anyone.

## Troubleshooting

`singularity-flow doctor` says when this repository's hooks would not run:

- Copilot CLI skips a repository's hooks in a folder it does not trust. SFlow's plugin needs no trust and still guards.
- `disableAllHooks` in `.github/copilot/settings.json`, or in a person's own `settings.local.json`, turns every hook off, the plugin's too.
- The hook file is missing or differs from what SFlow writes for the setting: run `singularity-flow doctor --repair-hooks` and commit what it writes.
- SFlow's plugin is installed but the repository has no hook file, so nothing guards a chat on a machine without SFlow.

Where hooks are off, nothing here applies, and the lifecycle's own checks stay the backstop.

**A known limit.** A chat opened outside a repository that uses SFlow is not guarded when it changes files in one: a host loads a repository's hooks only from the folder a chat was opened in, and SFlow's plugin starts its guard only for a session whose folder uses SFlow.

## Related topics

- `capability-management`: where the setting lives and how a proposal is reviewed.
- `environment-bindings`: files that hold secrets, refused in every chat.
- `approvals`: what a code step's approval waits for.
