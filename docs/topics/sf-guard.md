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
  - Which changed lines came from outside the workflow?
  - Why does approve ask for Touch ID?
  - Why is an approval not counted?
  - Why does a risk or scope decision ask for Touch ID?
  - What does the SF Guard remote check verify?
  - How do I make the SF Guard check required?
keywords:
  - presence signature
  - secure enclave
  - touch id
  - per-person exception
  - sc_auth
  - attribution
  - agent stamp
  - remote check
  - branch protection
commands:
  - guard
  - governance
related:
  - approvals
  - configuration
  - copilot-and-surfaces
version: 6
---
SF Guard makes a person's own steps provable. An agent runs as the same user on the same computer: it can read Git configuration, run any command, fake a terminal and write Git records directly, so nothing it can type proves a person decided. SF Guard asks for the one thing it cannot produce, a signature from a Secure Enclave key on the person's Mac made after their Touch ID. It is off until a repository opts in; a repository that never opts in behaves exactly as before. Refusals keep the `PSS_` codes of SPEC-PSS-v1.

## Purpose and prerequisites

Use this topic to see whether SF Guard is on, to pin your presence key, to opt a repository in, or to record a per-person exception. You need a Mac with macOS 26 or later (`/usr/sbin/sc_auth`, `/usr/bin/ssh-keygen` and `/usr/lib/ssh-keychain.dylib`), your member entry in the approved configuration with your `githubLogin`, and a GitHub account where you can add an SSH signing key. Windows and Linux approvers have no signer yet: an approver with a key records a per-person exception for them.

## Use it from each surface

- **Shell:** `sflow guard status` reads. Every other action is your own step in your own terminal: `sflow guard register`, `rotate`, `recover`, `revoke`, `enable`, `disable`, and `exception add|revoke`. Each shows a card, then Touch ID prompts.
- **Copilot:** `/sf-guard` shows the status only. Every other `guard` action is refused for agents in every turn, and the refusal names your exact command. On a Story SF Guard requires, an agent's `approve` or `reject` (an `/sf-approve` turn included) is refused with `PSS_CARD_NOT_SHOWN` and your exact command: run it in your own terminal, where the card shows and Touch ID prompts.
- **VS Code:** run the same command in a terminal; a model-free approval on a Story SF Guard requires names that command. The panel surfaces arrive with M5.

## Guided workflow

1. Create a Touch ID identity, once: `/usr/sbin/sc_auth create-ctk-identity -l sf-guard -k p-256-ne -t bio`. It is non-exportable and lives in the Secure Enclave. `/usr/sbin/sc_auth list-ctk-identities -t ssh` shows its fingerprint (`SHA256:…`).
2. Get its public key: `/usr/bin/ssh-keygen -w /usr/lib/ssh-keychain.dylib -K -N ""` in an empty directory writes a key stub and its `.pub` (a reference, no secret). Add the `.pub` line to your GitHub account (Settings, SSH and GPG keys, New SSH key) as a **Signing Key**, and check the fingerprint GitHub shows matches the `sc_auth` one.
3. `sflow guard register` pins it. It refuses a key GitHub does not list, a key with a readable private copy (`~/.ssh`, `IdentityFile`, or a plain `ssh-agent` key), an identity that is exportable, not Touch ID protected or expired, and an unreachable GitHub (nothing is recorded; run it again).
4. `sflow guard enable --remote-check <NAME>` is the signed opt-in. Name `--exception <APPROVER-ID>` for an approver with no signer; `sflow guard status` lists approver IDs.
5. In a repository with an approved configuration branch, add `--propose` and approve the proposal (`sflow configuration approve <BRANCH>`); otherwise review the diff of `singularity/presence.json` and commit it.
6. Touch the sensor only for a command you started yourself, right after its card. The Touch ID prompt cannot name the action; a prompt you did not start is an agent asking, so decline it.

## State and safety

The policy is `singularity/presence.json` in the approved configuration: an append-only, hash-linked chain of signed events (`register`, `rotate`, `recover`, `revoke`, `enable`, `disable`, `exception`, `exception-revoke`). It names approvers by ID, never by email or login. Each event is signed by an approver's pinned key (a key event also by the key it pins), so an unsigned event, an agent's own key, an edited event, or a commit that deletes or shortens the file never counts: the longest valid chain the history shows stays in force and `guard status` names the problem. Verifying reads only the pinned keys, never GitHub, so an unreachable GitHub never blocks a step. A per-person exception lets that approver's steps proceed unsigned, labelled `bypass: per-person exception EXC-…` everywhere; it is a stated bypass for that person, and only an approver with a key can record or revoke one.

**Approve and reject (M2).** A Story pins SF Guard's policy when it starts (`resolution.presence` in its `workflow.json`), so turning SF Guard on or off later never changes a running Story. On a Story pinned `required`:

- `approve` and `reject` check everything first, before any prompt or write: that you are an approver, that your key is pinned (or an exception covers you), that this computer can sign (macOS 26), that this is your own terminal, and that this Mac holds your key. Each refusal names a route you can take today: run it on the Mac holding your key, `sflow guard rotate`, another approver deciding, or a per-person exception.
- Once every approval check passed, your card shows (Story, step, generation, decision, review packet, record digest), then one Touch ID prompt. Declining writes nothing (`PSS_PRESENCE_DECLINED`).
- The record carries `identityAssurance: "presence-signed"` and a `presence` block. The signature covers a digest of the record's own decision fields, so a record changed afterwards, or a signature carried to another record, does not verify (`PSS_SIGNATURE_INVALID`).
- Only a record whose signature verifies against the approver's pinned key, or one a per-person exception covers, counts toward the threshold, in the approval itself, `sflow approvals`, the work list's blockers, the editor view and retention. An approval written by hand with Git, or an unsigned one (`PSS_RECORD_UNSIGNED`), counts for nothing; `sflow approvals` lists it as not counted, with the reason.
- A Story started while SF Guard was off (pinned `off`, or with no pin) keeps working unsigned; once the repository opts in, its approvals read `pre-signing`. A pin edited by hand to say `off` that does not match the policy chain reads as `required`.

**A Story's other decisions (M3).** Every other decision a person records on a Story pinned `required` is signed the same way: risk, test-run risk and narrowing acceptances, test command acceptances and revocations, evidence reuse, visual profile and witness decisions, witness exception renewals, scope dispositions, completeness reviews, applicability, upstream issue and forward amendment decisions, and plan amendments and corrections. Each lands in the Story's `workflow.json`, so SF Guard signs where the Story is written: the decisions a command added (never one already on disk) show on one card, then one Touch ID prompt signs them together. The same checks and routes as approve apply first; declining, or any refusal, writes nothing. A request anyone may make, such as a test command request, is never signed and always counts. Each family's own reader (the gates, the scope inventory, the decision list) counts a decision only when its signature verifies against the approver's pinned key, or a per-person exception covers it, so a decision written into `workflow.json` by hand counts for nothing.

After a command you run in your own terminal in an opted-in repository, SF Guard warns (`PSS_FOREIGN_KEY`) when the key pinned under your approver ID is not held by this Mac, and names the revoke route. It never blocks the command. Steps recorded outside the Story's `workflow.json` (Spec Studio, configuration approval, appeals and their review records, plan actions, Epic and goal approvals, authorship claims) are not signed yet; the SF Guard specification lists each with its reason.

**Verified again, everywhere (M4).** The final check and the evidence receipt never trust a flag a record carries: each re-verifies every person record on the Story against its pinned keys. An approval that does not verify leaves the threshold unmet, and the refusal says SF Guard did not count it and names the approver's command; the record itself is named as not counted, never refused, so it blocks nothing by itself. The receipt adds a line such as `SF Guard: 2 signed · every signature re-verified`.

**The required remote check.** A clone can be patched, so the boundary is `sflow governance verify --presence`, run by an unmodified SFlow on the Git host's CI as a required status check of the default branch. Against the base of each change it checks that:

- the policy file only grew, and every event it adds verifies (`PSS_POLICY_UNSIGNED`, `PSS_POLICY_REWRITTEN`);
- each key event it adds is listed on the approver's GitHub account now, and a recovery's lost key is not (`PSS_KEY_NOT_LISTED`, `PSS_KEY_STILL_LISTED`). GitHub unreachable leaves the event "unconfirmed", never failing for that alone;
- every person record a Story adds verifies (`PSS_RECORD_UNSIGNED`, `PSS_SIGNATURE_INVALID`), no person record disappears (`PSS_RECORD_REMOVED`), and no withdrawal or invalidation is taken back (`PSS_WITHDRAWAL_REMOVED`). A record already on the base that does not verify is named, not failed, so an unrelated change is never held;
- a Story the change adds that reads as made before the opt-in really was: by commit ancestry, then by when GitHub first received each commit (`PSS_PIN_FORGED`).

Each failure names its route. A repository that never opted in passes. `sflow guard remote-check` shows whether branch protection requires the check SF Guard's opt-in named, and prints the CI recipe (`--recipe`) to save as `.github/workflows/sf-guard-verify.yml` and commit in a reviewed change; pin the SFlow release it installs with `--package-url` and `--package-sha256`. The recipe runs under `pull_request_target`, so a pull request cannot change what checks it, and installs SFlow from the pinned release, never from the repository. SF Guard never writes the recipe, commits it, or changes branch protection: you make the check required in the repository's settings. `guard status` and `guard enable` say while it is not required.

**A lone approver with no key.** When your only key is lost and `guard recover` is not possible (no GitHub account, no Mac), and no other approver can sign an exception for you, record one with `sflow guard exception add <APPROVER-ID> --host-review --reason TEXT` on a branch, and open a pull request. It carries no signature, so it is accepted only while no other approver holds a key, it is labelled as the repository owner's reviewed change, and the remote check fails it until a member other than its author approves the pull request on GitHub (`PSS_HOST_REVIEW_UNCONFIRMED`). A solo owner has no second reviewer, so for them this route is closed: use `guard recover`.

## Agent and skill attribution

SF Guard's second part records where agent work came from. It never refuses anything: work by an agent or skill the workflow doesn't declare is allowed and labelled. With SF Guard on, every Copilot edit and shell command in the repository is recorded on this machine with:
- its Copilot session;
- its agent: a subagent's own name, or a declared agent's stamp;
- its skill: a `skill` call, the prompt, or the SFlow skill a plain follow-up prompt continues;
- the Story the checkout is bound to.

Plain prompts and paused sessions are recorded too. A shell command keeps only a digest of its text, plus the HEAD and index state before and after. A command that never ran is recorded as not run. Records stay on the machine, kept 14 days, and a recording failure is kept as a gap that never changes what Copilot is allowed to do. A declared agent names itself through a stamping hook in its agent file, which runs `sflow hook agent-stamp <AGENT> userPromptSubmitted`. Without one, the agent reads as none. Copilot never names the agent you picked.

`singularity-flow guard enable` also writes that stamping hook into each agent file this repository owns, in the same reviewed change as the opt-in, and `singularity-flow guard stamp-agents` writes any that are missing or were edited (both are the person's own steps). A file with no hooks of its own gets one exact block before its closing `---` and no other change, so a framework agent stays as it shipped. APM's agent files are left to their package and read "agent unknown". If an agent file differs from its approved bytes, the session's records carry "agent files changed", because a changed file could let another agent stamp itself as that one.

`singularity-flow guard reconcile` gives every line the change set adds or changes exactly one class: in a Story checkout, the Story since its base against its step's declared agents and skills; anywhere else, the working tree and unpushed commits against the repository's.
- **declared**: a verified write by a declared agent and skill, or by SFlow's own skill.
- **outside-workflow**: plain Copilot with no agent and no skill, an agent the workflow doesn't declare (or one not listed for the step), or a skill it doesn't pin.
- **unknown-agent**: a declared skill's work, by an agent no hook named.
- **shell**: changed while a recorded shell command ran, such as `node -e`, and never credited to an edit.
- **pre-guard**: changed before SF Guard was on here, or in a Story pinned before it.
- **unattributed**: nothing recorded explains it: a person, another tool, a lost record, or a record claiming lines its own arguments don't explain. It never reads as "person"; only a presence signature proves a person.

It reads Git a fixed three times and stops at 500 files or 20,000 lines; a capped report says it is partial. With SF Guard on, an `upstream-issue raise` or `story intent-amendment propose` that a Copilot shell call runs without `--authored` is recorded as `governed-agent`, and an agent that claims `--authored human` for one is refused with its own command, except for the person's own words in their `/sf-decide`.

## Troubleshooting

- `PSS_ANCHOR_UNAVAILABLE`: GitHub could not be reached; nothing was recorded. Run the same command again.
- `PSS_KEY_NOT_LISTED`: add the key on GitHub as a Signing Key, or add your `githubLogin` to your member entry. Without a GitHub account, another approver records a per-person exception for you.
- `PSS_KEY_READABLE`, `PSS_KEY_NOT_PRESENCE`, `PSS_KEY_EXPIRED`: create a new identity as in step 1. An identity's certificate lasts one year (`Valid To` in `sc_auth list-ctk-identities`); before it expires, `sflow guard rotate --key <NEW>`, signed by the old and the new key.
- Lost Mac or key: remove the old key from GitHub, list a new one, then `sflow guard recover --key <NEW>` (the new key signs; recovery is labelled). Or another approver runs `sflow guard revoke <APPROVER-ID> --reason TEXT` and you register again.
- `PSS_POLICY_UNSIGNED` or `PSS_POLICY_REWRITTEN` in `guard status`: someone changed the policy without a valid signature. It did not take effect; nothing is blocked.
- `PSS_CARD_NOT_SHOWN` on `approve` or `reject`: it ran without your terminal (an agent, a script, a model-free route). Run the command it names in your own terminal.
- `PSS_SIGNER_UNAVAILABLE`: this computer cannot sign (not macOS 26), or this Mac does not hold your pinned key. Run the step on the Mac holding it, rotate to a key on this one, or ask another approver. If you never registered that key, revoke it: `sflow guard revoke <APPROVER-ID> --reason "not my key"`.
- `PSS_KEY_NOT_REGISTERED`: register your key (`sflow guard register`), or another approver decides or records an exception for you.
- `PSS_POLICY_UNREADABLE`: the approved configuration's policy file cannot be read here; nothing was written. `sflow sync`, then run the same command again.
- An approval shows "not counted" in `sflow approvals`: it carries no valid presence signature. The approver runs `approve` again in their own terminal.
- The remote check fails (`PSS_REMOTE_CHECK_FAILED`): its output lists each problem with its route. A forged or edited record is dropped from the change, and the person records the decision again in their own terminal.
- `guard status` says the remote check is not required: add the CI recipe (`sflow guard remote-check --recipe`) and make the check required in the repository's branch protection.

## Related topics

Continue with `sflow explain approvals`, `sflow explain configuration`, `sflow explain copilot-and-surfaces`.
