---
id: sf-guard
title: SF Guard
aliases:
  - presence-signing
  - presence-key
  - touch-id-signing
questions:
  - What is SF Guard?
  - How do I register my Touch ID presence key?
  - How do I turn on presence-signed approvals?
  - What is a per-person exception?
  - I lost my Mac; how do I recover my presence key?
  - Which agent and skill made this change?
keywords:
  - presence signature
  - secure enclave
  - touch id
  - per-person exception
  - sc_auth
  - attribution
  - agent stamp
commands:
  - guard
related:
  - approvals
  - configuration
  - copilot-and-surfaces
version: 2
---
SF Guard makes a person's own steps provable. An agent runs as the same user on the same computer: it can read Git configuration, run any command, fake a terminal and write Git records directly, so nothing it can type proves a person decided. SF Guard asks for the one thing it cannot produce, a signature from a Secure Enclave key on the person's Mac made after their Touch ID. It is off until a repository opts in; a repository that never opts in behaves exactly as before. Refusals keep the `PSS_` codes of SPEC-PSS-v1.

## Purpose and prerequisites

Use this topic to see whether SF Guard is on, to pin your presence key, to opt a repository in, or to record a per-person exception. You need a Mac with macOS 26 or later (`/usr/sbin/sc_auth`, `/usr/bin/ssh-keygen` and `/usr/lib/ssh-keychain.dylib`), your member entry in the approved configuration with your `githubLogin`, and a GitHub account where you can add an SSH signing key. Windows and Linux approvers have no signer yet: an approver with a key records a per-person exception for them.

## Use it from each surface

- **Shell:** `sflow guard status` reads. Every other action is your own step in your own terminal: `sflow guard register`, `rotate`, `recover`, `revoke`, `enable`, `disable`, and `exception add|revoke`. Each shows a card, then Touch ID prompts.
- **Copilot:** `/sf-guard` shows the status only. Every other `guard` action is refused for agents in every turn, and the refusal names your exact command.
- **VS Code:** run the same command in a terminal. The panel surfaces arrive with M5.

## Guided workflow

1. Create a Touch ID identity, once: `/usr/sbin/sc_auth create-ctk-identity -l sf-guard -k p-256-ne -t bio`. It is non-exportable and lives in the Secure Enclave. `/usr/sbin/sc_auth list-ctk-identities -t ssh` shows its fingerprint (`SHA256:…`).
2. Get its public key: `/usr/bin/ssh-keygen -w /usr/lib/ssh-keychain.dylib -K -N ""` in an empty directory writes a key stub and its `.pub` (a reference, no secret). Add the `.pub` line to your GitHub account (Settings, SSH and GPG keys, New SSH key) as a **Signing Key**, and check the fingerprint GitHub shows matches the `sc_auth` one.
3. `sflow guard register` pins it. It refuses a key GitHub does not list, a key with a readable private copy (`~/.ssh`, `IdentityFile`, or a plain `ssh-agent` key), an identity that is exportable, not Touch ID protected or expired, and an unreachable GitHub (nothing is recorded; run it again).
4. `sflow guard enable --remote-check <NAME>` is the signed opt-in. Name `--exception <APPROVER-ID>` for an approver with no signer; `sflow guard status` lists approver IDs.
5. In a repository with an approved configuration branch, add `--propose` and approve the proposal (`sflow configuration approve <BRANCH>`); otherwise review the diff of `singularity/presence.json` and commit it.
6. Touch the sensor only for a command you started yourself, right after its card. The Touch ID prompt cannot name the action; a prompt you did not start is an agent asking, so decline it.

## State and safety

The policy is `singularity/presence.json` in the approved configuration: an append-only, hash-linked chain of signed events (`register`, `rotate`, `recover`, `revoke`, `enable`, `disable`, `exception`, `exception-revoke`). It names approvers by ID, never by email or login. Each event is signed by an approver's pinned key (a key event also by the key it pins), so an unsigned event, an agent's own key, an edited event, or a commit that deletes or shortens the file never counts: the longest valid chain the history shows stays in force and `guard status` names the problem. Verifying reads only the pinned keys, never GitHub, so an unreachable GitHub never blocks a step. A per-person exception lets that approver's steps proceed unsigned, labelled `bypass: per-person exception EXC-…` everywhere; it is a stated bypass for that person, and only an approver with a key can record or revoke one. In M1 the policy is recorded and shown; person steps start requiring signatures in M2.

## Agent and skill attribution

SF Guard's second part records where agent work came from. It never refuses anything: work by an agent or skill the workflow doesn't declare is allowed and labelled. With SF Guard on, every Copilot edit and shell command in the repository is recorded on this machine with:
- its Copilot session;
- its agent: a subagent's own name, or a declared agent's stamp;
- its skill: a `skill` call, the prompt, or the SFlow skill a plain follow-up prompt continues;
- the Story the checkout is bound to.

Plain prompts and paused sessions are recorded too. A shell command keeps only a digest of its text, plus the HEAD and index state before and after. A command that never ran is recorded as not run. Records stay on the machine, kept 14 days, and a recording failure is kept as a gap that never changes what Copilot is allowed to do. A declared agent names itself through a stamping hook in its agent file, which runs `sflow hook agent-stamp <AGENT> userPromptSubmitted`. Without one, the agent reads as none. Copilot never names the agent you picked.

## Troubleshooting

- `PSS_ANCHOR_UNAVAILABLE`: GitHub could not be reached; nothing was recorded. Run the same command again.
- `PSS_KEY_NOT_LISTED`: add the key on GitHub as a Signing Key, or add your `githubLogin` to your member entry. Without a GitHub account, another approver records a per-person exception for you.
- `PSS_KEY_READABLE`, `PSS_KEY_NOT_PRESENCE`, `PSS_KEY_EXPIRED`: create a new identity as in step 1. An identity's certificate lasts one year (`Valid To` in `sc_auth list-ctk-identities`); before it expires, `sflow guard rotate --key <NEW>`, signed by the old and the new key.
- Lost Mac or key: remove the old key from GitHub, list a new one, then `sflow guard recover --key <NEW>` (the new key signs; recovery is labelled). Or another approver runs `sflow guard revoke <APPROVER-ID> --reason TEXT` and you register again.
- `PSS_POLICY_UNSIGNED` or `PSS_POLICY_REWRITTEN` in `guard status`: someone changed the policy without a valid signature. It did not take effect; nothing is blocked.

## Related topics

Continue with `sflow explain approvals`, `sflow explain configuration`, `sflow explain copilot-and-surfaces`.
