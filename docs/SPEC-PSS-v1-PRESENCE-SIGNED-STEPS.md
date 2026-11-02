# SPEC-PSS v1 — SF Guard: presence-signed person steps

**Status:**
- **Decided:** 1 November 2026 (§12).
- **M0:** run by the person on 1 November 2026 (§10.1).
- **M1:** built. It covers the verifier, the signed policy chain, key pinning with its GitHub anchor, the opt-in, per-person exceptions, `singularity-flow guard` and `/sf-guard`.
- **M2:** built (§10.2). Approve and reject are presence-signed on a Story SF Guard requires, and only a verified or excepted approval counts.
- **M3 and M4:** built (§10.3, §10.4).
- **M5:** built (§10.11): the VS Code surfaces and the first-run card.

**Grounded on:** main `e9fd1a04a`. `file:line` references are to that commit unless they name an M1 file.

**Requirement (the user, 1 November 2026):** "No agents can bypass" a person-only step, and "Nothing should get blocked".

**Name:** SF Guard everywhere a person reads it:
- the CLI `singularity-flow guard`;
- the Copilot skill `/sf-guard`;
- the help pages;
- the docs topic `sf-guard`.

Refusal codes keep the `PSS_` prefix. Internal modules live in `src/presence/`.

**Decisions:**
- **Signer:** Touch ID on Mac, through macOS's own Secure Enclave identities (`sc_auth`) and OpenSSH. No SFlow helper.
- **Trust anchor:** the approver's GitHub-listed SSH signing key, read at registration, plus a required remote check.
- **Verification:** reads only the keys pinned in the approved configuration, never GitHub.
- **Rollout:** opt-in per repository.
- **Windows:** deferred. A Windows approver in an opted-in repository gets a signed per-person exception, labelled as a bypass for that person.

## 0. Summary

**What gets signed.** Every person-only step (§3) writes a record with a **presence signature**: approve and reject, every decision a person records, Spec Studio's person steps, configuration approval, plan actions, and the rest of §3. The signature comes from a Secure Enclave key that never leaves the Mac, and only after the person's Touch ID.

**How it is checked.** In a repository that has opted in, every place that counts such a record verifies its signature against the approver's pinned key in the approved configuration's SF Guard policy (§6). A record that is unsigned, or whose signature does not verify, counts for nothing. So an agent gains nothing by running the command, scripting it, faking a terminal or writing the Git record by hand.

**What it never does.**
- It never blocks a repository that has not opted in, where behaviour is exactly as before.
- It never strands a person: every refusal names a route a person can take today (§8, REQ-042).
- It never fails because GitHub is unreachable when it verifies.

**The remote check.** A required check on the remote's default branch re-verifies every signature and re-reads GitHub, so a record forged on a machine whose SFlow was patched still cannot merge.

**The Copilot guard.** The guard (1a3f18d56, e9fd1a04a) stays. It spares the person unexpected prompts, and it is no longer the boundary.

## 1. Why: today's code

| Fact | Where |
| --- | --- |
| An approval's identity is the Git email (`configured-local`) or the `gh` login (`github-authenticated`). The agent has both | `src/approval-authority.mjs:337-345`, `:362` |
| `approve <step> --yes` approves with no terminal. `--selection-receipt` is the chat route | `src/commands/approve.mjs:93-101` |
| The strongest "person" proof today checks that stdin, stdout and stderr are TTYs, then compares a typed label. `script`, a pty and a pipe beat it | `src/action-authorization.mjs:103`, `:127` |
| Machine-local integrity uses an HMAC key in `.git`, which the agent can read | `src/publication-machine-integrity.mjs:10` |
| The Copilot hook refuses person steps by reading the shell line's text, so a script file that calls them passes | `src/copilot-mutation-guard.mjs` |
| An approval binds `actor`, `authorityGroup`, `identityAssurance`, `generation`, `reviewPacketSha256` and `evidenceCommit`, but nothing a person alone can produce | `src/state.mjs:6769-6789` |

## 2. Threat model

**[PSS:CON-001] What an agent can do.**
- It runs as the same OS user, and can run any shell command or launch processes outside its own ancestry.
- It can fake a terminal and pipe input.
- It can read the person's Git config, `gh` token, `~/.ssh`, `ssh-agent` identities, SFlow state and `.git` keys.
- It can write Git objects and refs directly.
- It can edit SFlow's installed files.
- It can set `NODE_EXTRA_CA_CERTS`, `HTTPS_PROXY` and similar environment variables for the processes it starts.
- It can create its own Secure Enclave identities with `sc_auth`, and load any OpenSSH security-key provider, including a software one it wrote.

**[PSS:CON-002] What it cannot do.**
- It cannot use a Secure Enclave key created with biometric protection without the person's Touch ID. M0 measured a fresh prompt for each of two back-to-back signatures (§10.1).
- It cannot add a signing key to the person's GitHub account without the person signing in again in a browser. The local `gh` token has scopes `gist, read:org, repo, workflow`, and no `write:ssh_signing_key`.
- It cannot make `/usr/sbin/sc_auth`, which System Integrity Protection guards, list its software key as a `p-256-ne`/`bio` identity.

**[PSS:CON-003] The guarantee.**
- **No forged record verifies on an unmodified SFlow build,** or on the remote check, for a repository that has opted in.
- **A patched SFlow can only fool its own clone.** The required remote check (REQ-030) stops a forged record from reaching the default branch.

**Non-goals:**
- root malware;
- a person who touches a prompt they did not start (REQ-012);
- hardware attestation of macOS keys, which Apple offers only through MDM;
- Windows and Linux signers (§5.2);
- repositories that have not opted in (REQ-040).

## 3. Person-only steps

**[PSS:REQ-001]** A person-only step is any command whose effect is a person's decision. The authoritative list is the union of:
- `OWN_TERMINAL_STEPS` (`src/command-skills.mjs`);
- `liveTerminalReviewStep`;
- the Copilot guard's `PERSON_DECISIONS` and person steps (`src/copilot-mutation-guard.mjs`, e9fd1a04a).

SF Guard's own actions joined the first as `sf-guard-person-step` (M1).

| Step | Command | Record it writes | Counted by |
| --- | --- | --- | --- |
| Approve / reject a step | `approve`, `reject` | `phase.approvals[]` decision (`src/state.mjs:6769`, `:6842`, `:7846`); `decisions/<at>-<decision>.json` and `approval.json`, family `phase-approval` v2 | `approvalRequirementsMet` (`src/approval-authority.mjs:185`) via `approval-chain.mjs:126`, the final check (`evidence/evaluate.mjs:48`), retention, the gateway, `state.mjs`, snapshots, and the VS Code views and receipts built on these |
| Evidence sign-off | `approve --confirm-evidence` | witness records (`src/commands/approve.mjs:152`) | the evidence graph and the final check |
| Witness, risk, test-run risk, narrowing, evidence reuse, visual profile, witness exception | `decision witness\|risk\|test-risk\|test-narrowing\|evidence-reuse\|visual-profile\|witness-exception` | Story decision records and quality risks | the gates and the final check that read them |
| Test command accept, revoke, re-pin or removal | `decision test-command --accept\|--revoke` | `testCommandDecisions` | the pin gate and the decision list |
| Decision list, scope, plan, adjudication, constitution exception, repair, telemetry | `decisions record`, `decision scope\|applicability\|completeness\|choose\|plan`, `reopen`, `story adjudicate`, `review-source decide`, `constitution except`, `repair authorize`, `telemetry enable` | their own records | their readers |
| Appeals, test policy, approver refresh | `appeal …`, `story test-policy … --apply`, `story approvers refresh --confirm` | `src/phase-appeals.mjs`, `src/story-test-*.mjs`, `src/story-approver-refresh.mjs` | their gates and replay |
| Spec Studio | `spec author accept\|reject\|decide\|settle\|publish\|discard`, `spec split --publish`, `spec attach --drop` | draft events, revisions, split | publish gate, coverage, Story start |
| Configuration approval | `configuration approve` | `approveProposal` (`src/configuration-drafts.mjs:1083`) | every pinned configuration read, including SF Guard's policy |
| Plan actions | `action authorize\|execute` | authorization (`src/action-authorization.mjs:59-95`) | `consumeActionAuthorization` |
| Epic, goal, SGOS, intent, capability lease, host policy, agents lock | `initiative approve\|review\|complete`, `goal plan approve`, `program approve --confirm`, `intent ratify\|confirm`, `capabilities lease`, `ledger deployment-check`, `agents lock` | their own records | Epic gates, goal readiness and their readers |
| SF Guard itself | `guard register\|rotate\|recover\|revoke\|enable\|disable\|exception` | events in `singularity/presence.json` (§6) | the policy fold (`src/presence/chain.mjs`) |

**[PSS:REQ-002] Interim fixes, ahead of M0.** Landed in `e9fd1a04a`:
- the environment-variable confirmation bypasses are removed;
- every decision a person records is refused outside the skill turn they start for it, in plain prompts too;
- the terminal-only steps are refused in every turn;
- any SFlow command run with `NODE_ENV=test` or a `SINGULARITY_FLOW_TEST_` variable is refused for agents.

A script that runs a command itself is still not caught. That is this spec's job.

## 4. The signed statement

**[PSS:IFC-001] Statement.** Canonical compact JSON (`compactCanonicalJson`, `src/records.mjs`; built by `src/presence/statement.mjs`):

```
{ "schema": "pss-statement/1",
  "repository": "presence:<chainId>",              // the repository's SF Guard chain, never a path
  "subject": { "kind": "presence-chain|story|initiative|goal|spec|configuration|plan", "id": "…" },
  "step": "specification" | null, "generation": 1,
  "action": "phase.approve" | "presence.register" | …,   // closed list, one per §3 row
  "decision": { … },                               // the action's own values
  "reviewed": { … },                               // exactly what the person saw
  "actor": { "approver": "approver-<12 hex>" },    // an approver ID, never an email or login
  "authorityGroup": "…" | null,
  "at": "RFC3339", "nonce": "<128-bit hex>", "keyId": "SHA256:<fingerprint>" }
```

- **What `reviewed` holds:** the digest the step already binds:
  - the review packet and evidence commit for an approval;
  - the plan hash for an action;
  - the card digest for a terminal review;
  - the draft digest for Spec Studio;
  - the proposal digest for configuration;
  - the previous event's digest for an SF Guard event.
- **Rebuilt, never trusted:** the verifier recomputes every field from the record it checks, so a signature cannot move to another record, generation or digest.
- **Approver IDs:** an approver ID is `approver-` followed by the first 12 hex digits of SHA-256 of the member's `github:<login>`, or of `email:<address>` when the member has no login (`approverId`, `src/presence/chain.mjs`). Records name approvers by ID; the approved configuration's member list keeps the emails and logins.

**[PSS:IFC-002] Signature.** SSHSIG, the `ssh-keygen -Y sign` format, with namespace `singularity-flow-person-step@1`.
- **Key type:** only `sk-ecdsa-sha2-nistp256@openssh.com`. A `p-256-ne` Secure Enclave identity appears this way through Apple's provider `/usr/lib/ssh-keychain.dylib`. Any other key type never verifies, because an ordinary key's private half can sit in a file an agent reads.
- **Flags:** the user-presence flag is required. The user-verification flag is reported but never required (§10.1).
- **Verification:** `verifyPresenceSignature` (`src/presence/sshsig.mjs`) verifies with Node's `crypto` and no dependency. It reads PROTOCOL.sshsig and PROTOCOL.u2f, checks the namespace, the exact key, the hash algorithm and the flags, and runs in well under a millisecond.
- **OpenSSH agrees on the bytes but decides nothing:** `ssh-keygen -Y verify` agrees with it on every fixture. It is not the verifier, because it ignores the flags: it accepts a security-key signature nobody touched (M1 finding).

**[PSS:REQ-003] Placement (M2, M3).**
- Each person record gains `presence: { statement, signature, keyId, signer: "secure-enclave-ctk" }` and `identityAssurance: "presence-signed"`.
- Every family holding a §3 record takes a version bump through `schema-migrations.mjs`, with current-version and future-version refusal fixtures, under one GDP companion lock review per milestone.
- Closed field lists are widened deliberately.

## 5. Signer

### 5.1 macOS: built-in Secure Enclave identities

**[PSS:IFC-003] Signer contract** (`src/presence/signer.mjs`, `src/presence/local-keys.mjs`).
- **No SFlow helper.** SFlow drives `/usr/sbin/sc_auth`, `/usr/bin/ssh-keygen` and `/usr/lib/ssh-keychain.dylib` by absolute path, with a minimal environment of its own, never through `PATH`.

| Step | Command |
| --- | --- |
| Create (the person, once) | `sc_auth create-ctk-identity -l <label> -k p-256-ne -t bio`. Non-exportable, in the Secure Enclave, Touch ID protected |
| Key handle | `ssh-keygen -w /usr/lib/ssh-keychain.dylib -K -N ""` in a private temporary directory writes key stubs and their `.pub` files. A stub is a reference to the identity, with no secret. SF Guard makes them for each signing and deletes them afterwards |
| Sign | `SSH_SK_PROVIDER=/usr/lib/ssh-keychain.dylib ssh-keygen -Y sign -f <stub> -n singularity-flow-person-step@1`, with the statement on stdin. Touch ID prompts. SF Guard verifies the result before using it |
| Inspect | `sc_auth list-ctk-identities -t ssh` lists key type, SSH fingerprint, protection, label, common name, email, "Valid To" and "Valid" |

**[PSS:REQ-012] Residual risk: the prompt cannot name the action.**
- **The risk:** the Touch ID prompt is the system's and its text is generic. An agent can start a signing for a different action than the one the person thinks they are approving, and the person sees the same prompt.
- **Mitigations:**
  1. **The card first.** The step prints its card to the person's terminal immediately before signing: subject, step, generation, action, the chain event, and the key fingerprint. Signing refuses without a terminal for the card (`PSS_CARD_NOT_SHOWN`).
  2. **The same process.** The signing subprocess is started by the process that printed the card, with the statement that process rendered. A statement prepared elsewhere is never signed.
  3. **The rule,** on every card, in the docs and in help: *touch the sensor only for a command you started yourself, right after its card. A prompt you did not start is an agent asking: decline it.*
  4. **After the fact.** Every signed record shows its card digest and signer, and `guard status` lists every event, so an unexpected one is visible.

**[PSS:REQ-013] A fresh touch per signature.** Met as measured: two signatures in a row each prompted (§10.1). The no-touch-window choice falls away.

**[PSS:REQ-014] Key lifetime.**
- **Certificate expiry:** an `sc_auth` identity carries a certificate valid for one year ("Valid To", for example `11/1/27`), and "Valid" turns `NO` after it.
- **Refusal:** SF Guard refuses an expired identity (`PSS_KEY_EXPIRED`), naming the key and the rotation route: create a new identity, list it on GitHub, `guard rotate --key <NEW>`.
- **Fingerprint changes:** whether enrolling or removing a fingerprint invalidates a `-t bio` identity is still to be observed. If it does, the person re-registers through `guard recover`.

### 5.2 Windows: deferred

**[PSS:REQ-010]**
- Windows Hello signing is deferred. Its prompt can't name the action, it accepts a PIN, and its key storage may be software.
- A Windows approver in an opted-in repository gets a signed per-person exception (REQ-041). Every surface, receipt and final check labels their steps "bypass: per-person exception EXC-…".

### 5.3 No signer available

**[PSS:REQ-011]**
- **When it applies:** in a repository that has opted in, a person step on a machine without a usable signer is refused before anything is written (`PSS_SIGNER_UNAVAILABLE`). That covers an Intel Mac without a T2 chip, macOS before 26, Windows and Linux, CI, and a remote shell without a local gesture.
- **The routes it names:** run the step on a registered Mac, have another approver do it, or record a per-person exception.
- **Never signers:** agents and CI never sign.

## 6. Keys, the policy chain and the trust anchor

**[PSS:REQ-020] The problem.** An agent can create a software key, or its own Secure Enclave identity, and register it under the person's name. macOS cannot prove where a key lives, outside MDM. So trust needs an anchor the agent cannot reach.

**[PSS:REQ-021] Anchor: the GitHub-listed key.**
- **Pinning:** a key is pinned only while it is listed as an SSH signing key on the approver's GitHub account, read live at `register`, `rotate` and `recover` (`src/presence/anchor.mjs`).
- **Read only at registration:** GitHub is never read when a signature is verified. The pinned key in the approved configuration is the verifier's only input, so an unreachable GitHub never blocks a step.
- **The read itself:** it uses Node's bundled root certificates and no environment proxy, so `NODE_EXTRA_CA_CERTS` and `HTTPS_PROXY` cannot put a forged listing in front of it.
- **Unreachable:** `PSS_ANCHOR_UNAVAILABLE`, with nothing recorded; the person runs the same command again. It is never read as "listed".
- **The login:** it comes from the approver's member entry in the approved configuration (`githubLogin`), never from a flag. An approver without one is refused with two routes: add the login, or have another approver record a per-person exception.
- **The remote check (M4):** it re-reads GitHub for every key event new in a change, and reports GitHub unavailable instead of failing as long as every signature verifies against its pinned key. A new key event it could not confirm stays "unconfirmed" until a later run confirms it; it never fails a merge for that alone.

**[PSS:REQ-022] The policy chain** (`src/presence/chain.mjs`, `src/presence/store.mjs`).
- **Where:** SF Guard's policy is `singularity/presence.json` in the approved configuration (schema `sflow-presence-chain@1`).
  - **Why there:** M1 moved it from the per-member state-branch files and the `approvalSecurity` field first planned. A Story pins its configuration at start (M2), and the chain protects itself: a field in `workflow.yml` would change with any unsigned configuration change until M3 signs configuration approval.
- **The list:** a `chainId` and one append-only list of events: `register`, `rotate`, `recover`, `revoke`, `enable`, `disable`, `exception`, `exception-revoke`.
- **Links and signatures:** each event links to the previous one by digest and carries its signatures. Each signature covers the IFC-001 statement of the event, with subject `presence-chain`, generation the event's sequence number, and `reviewed.previous` the link.
- **Who may sign what** (folding stops at the first event that breaks a rule):
  - `register`: the key it pins, for an approver with no pinned key. No two approvers may pin the same key.
  - `rotate`: the old pinned key and the new key.
  - `recover`: the new key, while the event records that GitHub lists the new key and no longer lists the old one.
  - `revoke`: any pinned key, the approver's own or another approver's.
  - `enable`, `disable`, `exception` and `exception-revoke`: any approver's pinned key.
- **The longest valid prefix counts.** An unsigned or unauthorized event, an agent's own key, or an event edited in place stops the fold there, so it can neither turn SF Guard off nor add a key, and it never blocks anyone. `guard status` names it (`PSS_POLICY_UNSIGNED`, `PSS_CHAIN_INVALID`).
- **The file may only grow.** Workflow Studio's `presence.set` refuses a chain that drops or rewrites events, or adds one that does not verify. The reader replays the file's history on the approved configuration branch, so a commit that deletes, shortens or rewrites it never takes effect: the longest chain the history shows stays in force (`PSS_POLICY_REWRITTEN`). A rewrite a later commit undid is history, not a problem.
  - **Limit, stated:** rewriting the branch's history itself is caught by the remote check and branch protection (M4), not locally.
- **A person's change is a configuration change:** written in place when the checkout is the configuration, or proposed for review with `--propose` when an approved configuration branch exists.

**[PSS:REQ-025] One dedicated presence key per approver.** At registration SF Guard refuses a key when any of these holds:
1. **A readable copy.** The key's private half is in a readable file: any private key under `~/.ssh` or at an `IdentityFile` path `ssh -G` names. This is checked by comparing public halves, never by printing private material.
2. **A plain agent key.** It is a plain identity in `ssh-agent`, as `ssh-add -L` lists them (`PSS_KEY_READABLE`). A security-key handle is not a copy, since it signs only with the token's touch.
3. **Not a presence identity on this Mac.** `/usr/sbin/sc_auth list-ctk-identities -t ssh` does not list it with key type `p-256-ne`, protection `bio` and Valid `YES` (`PSS_KEY_NOT_PRESENCE`, `PSS_KEY_EXPIRED`).

**What this proves, and what it doesn't:**
- **It proves,** to an unmodified local SFlow, that the pinned key is a non-exportable, Touch ID protected Secure Enclave identity on this Mac, and not a key in a file or in `ssh-agent`.
- **It cannot prove** anything to a remote verifier, and a patched SFlow skips it.
- **It can't stop a planted GitHub key,** so registration tells the person to compare the fingerprint `sc_auth list-ctk-identities -t ssh` shows them with the one GitHub shows.
- **The boundary** remains the GitHub listing at registration, the signed chain, and the remote check.

**[PSS:REQ-026] Bootstrap.**
- **The first opt-in** is an `enable` event signed by an approver whose key the chain already pins; that approver's `register` is the chain's first event. The opt-in may name per-person exceptions.
- **Self-signed keys:** a `register` is self-signed with a recorded GitHub snapshot. Its live confirmation is the registering clone's read and the remote check (REQ-021).

### 6.1 Nothing silent

**[PSS:REQ-023]**
- **What every surface shows:** every surface that shows a person record also shows its signer and key fingerprint, or its "bypass: per-person exception EXC-…" label: the approval view, the decision list, receipts and VS Code. `guard status` lists every approver's standing, every exception and every problem.
- **A key the person doesn't hold:** when the person's own Mac finds a key pinned under their approver ID that its Secure Enclave does not hold, `guard` commands there stop with `PSS_FOREIGN_KEY`, naming the event and the revoke route. M1 refuses to sign with a key this Mac does not hold. The every-command alarm comes with M2.

### 6.2 Rotation, revocation, loss and recovery

**[PSS:REQ-024]**
- **Rotation (`guard rotate --key <NEW>`):** the new identity is listed on GitHub, and the event is signed with both the old and the new key: two touches.
- **Revocation (`guard revoke <APPROVER-ID> --reason`):** signed by any approver's pinned key. Removing a key from GitHub doesn't revoke it by itself: verification never reads GitHub, so a signed revoke, or the remote check, acts on it.
- **Lost Mac or key, recovering alone (`guard recover --key <NEW>`):**
  - The person removes the old key from GitHub, lists a new one, and records `recover`, signed by the new key.
  - It is refused while GitHub still lists the old key (`PSS_KEY_STILL_LISTED`), so whoever holds the old key cannot keep signing.
  - It is labelled "recovered" everywhere, and the remote check confirms it live (REQ-021).
- **Lost Mac or key, through another approver:** they revoke the key, and the person registers again.
- **Earlier records** signed before a revocation or rotation stay valid.

## 7. Verification everywhere (M2 to M4)

**[PSS:REQ-030]**
- **One verifier:** `verifyPersonRecord(record, { policy })` returns `{ valid, signer, reason }`. It is called by every reader in §3's last column.
  - In a repository whose policy requires presence, `approvalRequirementsMet` and its peers count only `valid` records and those under an active per-person exception.
  - The refusal is `PSS_RECORD_UNSIGNED` or `PSS_SIGNATURE_INVALID`, naming the record and the step to redo.
- **Re-checks:** receipt replay and the final check re-verify signatures rather than trusting an earlier flag, so a record written with plain Git gains nothing.
- **Remote check, required:**
  - `governance verify --presence` runs as a required status check on the default branch. It re-verifies every signature against the pinned keys, re-reads GitHub for new key events, and walks the policy file's protected history.
  - Opting in records the check's name (`--remote-check`). M4 reads the default branch's protection, warns while the check is not required, and lists it in `guard status`.
  - It reports GitHub unavailable, never failing for it alone (REQ-021).

**[PSS:REQ-031] Cost.**
- **Verification:** one signature verifies in well under a millisecond, and the policy is one file read.
- **Lazy loading:** the verifier and policy modules are imported only where a person record is counted or the policy is shown.
- **Budgets:** the hook and start closures don't grow. Each milestone measures the cli-bundle and VS Code budgets.

## 8. Policy, rollout and migration

**[PSS:REQ-040] Opt-in per repository.**
- **Off by default:** SF Guard is off until `singularity/presence.json` holds a valid `enable`. A repository that never opts in has no file, and its behaviour is exactly today's.
- **Turning it on:** the signed bootstrap (REQ-026).
- **Turning it off or weakening it** must be signed by a pinned key. That covers `disable`, revoking a key, and adding an exception. An unsigned change never counts (REQ-022): an unmodified SFlow and the remote check both read the policy as it was.
- **Running Stories:** a Story pins the policy at start (M2), so a later change never affects it.

**[PSS:REQ-041] Per-person exceptions.**
- **What creates one:** a signed policy record, `exception` or an entry in `enable`. It names one approver by approver ID (never a personal identifier), a reason (default "Windows: no presence signer yet") and who signed it. It is made in the signed opt-in itself, or later by any approver with a pinned key. An agent cannot create one, because it needs a signature.
- **While it holds:** that approver's person steps proceed unsigned. Every surface, receipt and final check labels them "bypass: per-person exception EXC-NNN", and they never read as signed.
- **Revoking one** (`exception-revoke`) is signed too.
- **Records made while a Story's policy was `off`** stay valid, labelled `pre-signing`. The final check names them as informational. On a `required` Story an unsigned record that no exception covers counts for nothing.

**[PSS:REQ-042] Never blocked, never stranded.**
- **Never blocked:** presence signing must never leave a person unable to take their step, and must never block a repository that hasn't opted in.
- **Every refusal names a route a person can take today:**
  - an exception (`guard exception add`, by another approver);
  - re-registration (`guard register`, `rotate`, `recover`);
  - recovery by another approver (`guard revoke`, then register);
  - running the same command again when GitHub was unreachable.
- **Recorded routes:** each route that changes the policy is labelled and recorded in the chain.
- **A lone approver whose only key is lost** recovers with `guard recover` (REQ-024). If that isn't possible, because they have no GitHub account or no Mac, the fallback is a labelled per-person exception. With no other approver to sign it, it is made through the repository owner's reviewed configuration change, which the remote check (M4) verifies as reviewed on the Git host.
- **An invalid or rewritten policy file** never blocks: the valid prefix holds.

**[PSS:REQ-043] CI.** No person step ever runs in CI. A CI process signs nothing and verifies everything.

## 9. What the person sees

**[PSS:REQ-050]**
- **In their own terminal:** the step prints its card, then Touch ID prompts. Declining or cancelling writes nothing (`PSS_PRESENCE_DECLINED`).
- **VS Code:** model-free person actions run the same command in a terminal, and the panel shows the card first (M5).
- **Copilot:** `/sf-guard` shows the status only. Every other `guard` action, and every §3 step, is refused for agents with the person's exact command. A prompt the person didn't start is declined, under REQ-012's rule.

## 10. Milestones

| ID | Delivers | Exit criteria |
| --- | --- | --- |
| M0 | The person runs `pss-m0-spike.sh`: a spike identity, a key stub, two timed signatures, verification, a tampered statement, an export attempt, deletion. Plus the inventory (REQ-001) | Done 1 November 2026 (§10.1) |
| M1 | Statement and verifier (`src/presence/statement.mjs`, `sshsig.mjs`). The signed policy chain in the approved configuration (`chain.mjs`, `store.mjs`, Studio `presence.set`). The GitHub anchor (`anchor.mjs`). One-key pinning with the readable-key and `sc_auth` checks, including expiry (`local-keys.mjs`). The signer path (`signer.mjs`). The opt-in, per-person exceptions, rotation, recovery and revocation. `singularity-flow guard`, `/sf-guard`, help and the `sf-guard` topic | AC-001 to AC-005, AC-012, AC-015, AC-016 |
| M2 | Approve and reject signed and verified everywhere approvals are counted. The Story pins the policy. `pre-signing` and exception labels on approvals. Signer-unavailable refusal. The foreign-key alarm on every command | AC-006 to AC-009 |
| M3 | Every other §3 row, family by family, with one lock review | AC-010. Done for every Story decision family recorded in `workflow.json` (§10.3); the rows recorded elsewhere are listed there with their reasons |
| M4 | Receipt replay, the final check, `governance verify --presence`, the CI recipe, the branch protection read, the remote GitHub re-read, the reviewed-change recovery for a lone approver | AC-011, AC-013. Done (§10.4) |
| M5 | VS Code surfaces, the first-run card with REQ-012's rule | AC-014. Done (§10.11) |

### 10.1 M0 results (1 November 2026)

The person ran `pss-m0-spike.sh` in their own terminal on macOS 26.7.1 (OpenSSH 10.3p1, arm64). The spike identity and its files were deleted afterwards.

| Check | Result |
| --- | --- |
| `sc_auth create-ctk-identity -k p-256-ne -t bio` | Created in 2.5 s. Listed as `p-256-ne`, `bio`, Valid To one year later, Valid YES |
| `ssh-keygen -w /usr/lib/ssh-keychain.dylib -K -N ""` | A `sk-ecdsa-sha2-nistp256@openssh.com` stub, in 0.03 s, without a prompt. Its fingerprint equals `sc_auth list-ctk-identities -t ssh`'s |
| Two signatures back to back | Touch ID prompted for each (2.7 s, 2.3 s): no window in which it signed without a touch |
| `ssh-keygen -Y verify` | Both good. A tampered statement was refused |
| Export of the identity | Refused (non-exportable) |
| `verify-required` | "Refused". M1 found this was not a result about the signature: OpenSSH 10.3 does not accept `verify-required` (or `no-touch-required`) in an allowed-signers file, and refuses every line that has it ("bad options: unknown key option") |

What M1 drew from it:
- The verifier requires user presence and never user verification. Whether Apple's provider sets the UV flag is unknown, because M0's spike files were deleted. SF Guard reads the flag from each real signature it verifies, and registration reports it.
- Biometry is the identity's own access control on the person's Mac, provable only through the `sc_auth` listing at registration and signing.
- `ssh-keygen -Y verify` ignores the flags, accepting a security-key signature with user presence clear. So SF Guard's own verifier decides (IFC-002).
- The listing's "Valid To" and "Valid" columns are the identity's certificate: one year, after which the identity is refused until rotated (REQ-014).

### 10.2 M2 as built (2 November 2026)

- **The Story pin.** `createWorkflow` records `resolution.presence` (`sflow-presence-pin@1`: `status` `required` or `off`, `chainId`, the number of valid events and the tip digest) when the approved configuration has a policy file, inside the creation policy anchor. A repository that never opted in writes no pin. A pin saying `off` must match the chain at the event it names and fold to `off` there; otherwise it reads as `required` (`pinRequirement`).
- **The record.** `src/presence/person-records.mjs`. A signed decision carries `identityAssurance: "presence-signed"` and `presence: { schema: "sflow-presence-record@1", chainId, approver, keyId, at, nonce, signature, userVerification }`. The IFC-001 statement's `decision` is `{ decision, recordSha256 }`, where `recordSha256` digests the record's own decision fields (`boundDecisionSha256`, an allowlist that leaves out what the engine adds later: invalidation and resolved change requests); `reviewed` is the review packet. A decision under an active exception carries `presence: { …, bypass: "EXC-…" }` and keeps its ordinary identity assurance, so it never reads as signed.
- **When the touch happens.** `approve` and `reject` call `preparePersonPresence` before any prompt or write: approver, policy readable (`PSS_POLICY_UNREADABLE`), exception (bypass), pinned key (`PSS_KEY_NOT_REGISTERED`), signer present (`PSS_SIGNER_UNAVAILABLE`, first, so CI and Windows read that), the person's own terminal (`PSS_CARD_NOT_SHOWN` with the exact command, also when an agent host's marker is set), and the key held on this Mac. The card and the touch come after every approval check passed (at the end of `evaluateApproval`; just before `rejectPhase` records), inside the publication transaction, so declining writes nothing.
- **Counting.** `presenceCounts(workflow)` is the predicate `approvalRequirementsMet`, `remainingRequiredAuthorities` and `storyApprovalView` take (`{ counts }`). It is used by approval itself (prior approvals and the distinct-identity check), `approvals`, the work-list blockers, the editor's approval view and phase retention. On a `required` Story whose chain this process did not read, it counts nothing. Keys that were rotated, recovered or revoked still verify records signed before the event that retired them.
- **Summaries.** `phase-approval` v3 (`COMPANION-LOCK-REVIEW-2026-11-02-SF-GUARD-M2.md`), written only when a decision carries a presence block.
- **The alarm.** After a command run with a terminal in a repository holding a policy file, `src/presence/alarm.mjs` warns `PSS_FOREIGN_KEY` when the key pinned under the person's approver ID is not among this Mac's identities, naming the revoke route. It never blocks.
- **Residual, stated.** A Story whose creation record an agent forges with no pin, or with a pin naming an earlier `off` point of the chain, reads as `pre-signing` locally: a local check cannot tell when a Story was really created. The remote check (M4) compares the Story's first push with the opt-in.

### 10.3 M3 as built (2 November 2026)

- **Where the signature is taken.** Every legitimate write of a Story's aggregate goes through `saveWorkflow` (`src/story-state-write.mjs`). On a Story pinned `required`, `signNewPersonRecords` (`src/presence/person-steps.mjs`) runs there, before the write. It finds the person records the command added, compares them with the state file on disk, and never offers one already there; a record the command only extended, such as a disposition gaining `withdrawnAt`, counts as already there. It runs M2's checks in M2's order and gives M2's routes. It shows one card listing every record, then takes one touch: a batch statement (`decision: { records: [digests] }`) that each record verifies against on its own. Each record keeps its own `identityAssurance`; its `presence` block names the signed `fields`, the batch, the action and the signature. Under an exception it carries `bypass`. Inside the publication transaction a refusal rolls back, so nothing is written.
- **The families** (`PERSON_STEP_FAMILIES`). Each family's readers count only verified or excepted records:

  | Family | List |
  | --- | --- |
  | Risk acceptance and revocation | `riskDecisions` |
  | Test command acceptance and revocation (a request is never signed) | `testCommandDecisions` |
  | Test narrowing | `testNarrowings` |
  | Test-run risk | `testRunRisks` |
  | Evidence reuse | `evidenceReuses` |
  | Visual profile | `visualProfileDecisions` |
  | Witness review, also from `approve --confirm-evidence`, where the confirmations take their own touch after the approval's | `witnessRecords` |
  | Witness exception renewal | `witnessExceptionRenewals` |
  | Scope disposition, also from `spec attach --drop` | `scopeDispositions` |
  | Completeness review | `completenessReviews` |
  | Applicability | `applicability` |
  | Upstream issue decision | `upstreamIssueDecisions` |
  | Forward amendment decision | `forwardAmendmentDecisions` |
  | Plan amendment, evidence-contract correction and plan row correction, also from an appeal's scope accounting | `planAmendments` |

- **Counting.** Loading a Story (`readWorkflow`) reads its chain once and registers its verdicts under the Story's pin in `src/presence/counted.mjs`, an import-free leaf. Each family's readers ask it synchronously with `countedRecords`; its writers number new records from the full list, so an ID never collides with an uncounted record. On a `required` Story whose chain the process did not read, no person record counts.
- **Schemas.** Each family's item schema in `schemas/workflow.schema.json` takes an optional `presence` block (`$defs.personPresence`), and so do `schemas/plan-evidence-amendment.schema.json` and the strict record schemas of plan row corrections, evidence amendments and upstream issue decisions. No registered schema family changed version, so no GDP companion changed and no lock review was needed. An older build refuses a record with a `presence` field wherever it validates strictly.
- **Not signed in M3, with why** (each is signed since §10.5 and §10.6; telemetry consent stays unsigned). Each of these rows writes outside the Story's `workflow.json`, or has no Story pin to require it. Each needs its own record format, and most need a schema family version under the GDP lock review:
  - **`decision choose`, `reopen`, `story adjudicate`, `review-source decide`, `constitution except`, `repair authorize`.** They write phase state, convergence and source-review records, constitution records and repair state.
  - **`telemetry enable`.** A machine-local preference, not a governance record.
  - **Appeals, `story test-policy … --apply` and `story approvers refresh`.** Committed decision files with exact-byte retention and their own families (`phase-appeal-decision`, `test-command-adoption-*`, `approver-refresh-*`), bound into workflow snapshot amendments. They already need the live terminal review. A plan amendment an appeal records is signed.
  - **Quality risk decisions (`qualityRiskDecisions`) and plan actions (`action authorize|execute`).** Strict packet schemas, and a committed-equality check on the list.
  - **Spec Studio person steps, `spec split --publish` and `configuration approve`.** Repository-level records with no Story pin. They need a repository-level requirement from the chain.
  - **Epic, goal, SGOS, intent, capability lease, host policy and agents lock.** Their own stores, with no Story pin.
  - **Authorship claims (`phase publish --authored human|external-tool`).** Signed since §10.5.
- **Residual, stated.** A withdrawal (`withdrawnAt`) is not signed. §10.5 makes readers independent of it.

### 10.4 M4 as built (2 November 2026)

- **One re-verification.** `src/presence/story-verify.mjs` lists every person record on a Story (each phase's approve and reject decisions, and every person decision in M3's families) and verifies each with M2's verdict against the keys the Story's pinned chain names. The final check, the evidence receipt and the remote check all use it. A Story re-verifies in well under AC-013's 50 ms.
- **The final check** (`runGovernanceGate`). On a Story pinned `required`, only an approval whose signature verifies counts toward the threshold and the required authorities. A threshold left unmet by uncounted approvals says so and names the approver's command. Each record that does not count is named as a warning, never refused, so a forged record cannot block a Story by itself (REQ-042). The final evaluation's review facet counts the same way, and a phase whose recorded approvals all fail to count reads `pending`. The final-check preview's in-memory decision is marked in a process-local `WeakSet` (`markSyntheticApproval`), never by a field, so a record on disk cannot claim it.
- **The receipt.** The evidence receipt's approval count counts only verified approvals, and a pinned Story's receipt carries a `presence` observation (signed, bypass, pre-signing, not counted) and the line `SF Guard: … · every signature re-verified`.
- **The remote check, `governance verify --presence [--base REF] [--pull-request N]`** (`src/presence/remote-check.mjs`), read only. Against the base of the change:
  - the working tree's policy file must extend the base's, and every event it adds must verify (`PSS_POLICY_REWRITTEN`, `PSS_POLICY_UNSIGNED`). An invalid event already on the base is a note;
  - each key event the change adds must be listed on the approver's GitHub account now, and a recovery's lost key must not be (`PSS_KEY_NOT_LISTED`, `PSS_KEY_STILL_LISTED`). GitHub unreachable leaves it in `unconfirmed`, and the check passes. Without a base, each pinned key GitHub no longer lists is a note;
  - each host-reviewed exception the change adds must be approved on the host by a member other than the pull request's author (`PSS_HOST_REVIEW_UNCONFIRMED`; unreadable is `unconfirmed`);
  - each person record a Story adds or changes must verify (`PSS_RECORD_UNSIGNED`, `PSS_SIGNATURE_INVALID`, each with the person's route). One already on the base is a note, so an older forgery never holds an unrelated change;
  - no signed or excepted person record on the base disappears (`PSS_RECORD_REMOVED`), and no `withdrawnAt`, `invalidatedAt`, `revokedAt` or `supersededBy` is taken back (`PSS_WITHDRAWAL_REMOVED`). One added is a note: it only makes the Story stricter. Records made before SF Guard carry no stable identity (an engine may add fields to them), so their history is not compared;
  - a Story that reads as not requiring presence while the repository is opted in must predate the opt-in: if the commit that added the opt-in's `enable` event is an ancestor of the Story's first commit, its pin was forged (`PSS_PIN_FORGED`). For a Story new in the change whose ancestry does not decide it, GitHub's activity record compares when the host first received each commit (`src/presence/host.mjs`); a date the host does not show is `unconfirmed`.

  A failure exits non-zero with every problem and its route (`PSS_REMOTE_CHECK_FAILED`). A repository that never opted in passes (`not-opted-in`). The check sends a GitHub token only inside GitHub Actions (`GITHUB_ACTIONS=true`), never from a person's computer.
- **The CI recipe** (`src/presence/remote-recipe.mjs`, printed by `guard remote-check --recipe`). It is a GitHub Actions workflow on `pull_request_target` and `push` to the default branch, which:
  - checks out the pull request's merge ref with full history, without persisting credentials;
  - installs Node 22 and the SFlow release the person pins (`--package-url`, `--package-sha256`), checked with `sha256sum --check`;
  - runs `governance verify --presence --base … [--pull-request …]` with the job's own token.

  `pull_request_target` runs the file as the default branch has it, so a pull request cannot change what checks it; its files are read as data and none of its code runs. SF Guard never writes, commits or pushes the recipe, and never changes branch protection.
- **The branch protection read** (`requiredStatusCheck`). `guard enable` and `guard status` read whether the check the opt-in named is a required status check of the default branch: `required`, `not-required`, `unprotected` or `unavailable`. They say while it is not required. `guard remote-check` (read) shows the same, with the recipe.
- **The lone approver's reviewed change** (REQ-042). `guard exception add <APPROVER-ID> --host-review --reason TEXT` records an `exception` event with `authorization: { kind: "host-review" }` and no signature. The fold accepts it only while no other approver holds a pinned key (otherwise that approver must sign one), and labels it as the repository owner's reviewed change. The remote check fails it until a member other than the pull request's author approves it on GitHub.
- **Residuals, stated.**
  - **A solo owner has no second reviewer,** so the host-review route is closed for them; `guard recover` remains.
  - **An agent holding the owner's token** could open and merge a pull request through the API where branch protection does not require a review by another member. The route's strength is the host's review rule.
  - **GitHub's activity record** may not reach back far enough for an old commit; such a comparison stays `unconfirmed`.
  - **Pull requests from forks:** the recipe reads them through the base repository's merge ref.
  - **The `setup-node` action** in the recipe is named by tag; the person pins it to a reviewed commit, as the checkout action already is.

### 10.5 Authorship claims, author keys and withdrawals (2 November 2026)

- **The user's decision.** An unsigned authorship claim is not believed. `phase publish --authored human` or `--authored external-tool` (and a legacy publication with no `--authored`) on a Story pinned `required` is believed only with its author's presence signature. Without one nothing is refused: the publication is recorded and checked as `governed-agent`, with every agent check, and the output names the route to sign next time.
- **Taking the claim** (`src/presence/authorship-claims.mjs`, called by `phase publish` before its transaction). The claimant is the person running the command (`actionActor`), not the session's attached actor; a claim they sign records them as the authorship actor. M2's checks run in order (policy readable, exception, pinned key, signer, own terminal, key held); any that fails reads the claim as the agent's. Otherwise the card names the producer, channel, step, generation and in-place artifact digest, and one touch signs a statement over the claim (`authorship.<producer>`). The `presence` block, with the claim it covers, is kept on the generation's authorship record (`schemas/generation-authorship.schema.json` allows it; no family changed version). A declined touch stops the command: the person cancelled. An imported claim (`--from`), or one on a step that does not allow agent authorship, has no agent reading, so it is refused (`PSS_CLAIM_UNSIGNED`) with the route to sign.
- **Reading it** (`believedProducer` in `src/presence/counted.mjs`, `authorshipClaimVerdict` in `person-records.mjs`). A claim counts only when its signature verifies against the claimant's pinned key, or a per-person exception covers them, and the signed claim matches the record: producer, channel, Story, step, generation, and the in-place artifact against the published source. Otherwise the generation reads as `governed-agent` where the agent checks are decided: the final check's clarification gate (`governance.mjs`) and readiness evidence's clarification row. A generation with no authorship record keeps the reader's own rule.
- **Author keys.** Any registered person can sign a claim. Someone who is not an approver registers with `guard register --author --github-login <LOGIN>` (also `rotate` and `recover`); GitHub must list the key, as for an approver. Their ID is their Git email's. The chain records `role: "author"` and the GitHub login on their key events (no member entry lists an author, so this is the one event that names a login, for the reviewed change and for M4's remote check, which confirms the key on that account), and folding keeps author pins apart (`authorPins`): an author's key signs only that author's own key events and claims, never `enable`, `disable`, `exception`, `exception-revoke` or `revoke`, and never another person's record. An approver revokes an author's key with `guard revoke`. `guard status` lists authors.
- **Withdrawals.** Every withdrawal in today's code comes with a newer decision for the same item, responsibility or inventory (a scope disposition, an applicability decision, a completeness review). On a Story SF Guard requires, readers take the newest counted decision by each record's own signed `at` (`inDecisionOrder`) and never read `withdrawnAt` (`isWithdrawn`). So adding, removing or moving withdrawals, or reordering the list, changes nothing; only deleting a newer signed decision could revive an older one, and M4's remote check, which compares the Story's history, catches a deletion.

### 10.6 Every other person step (2 November 2026)

Every row §10.3 left now takes its person's presence signature where SF Guard applies, with M2's checks in M2's order and its routes, and nothing written on a refusal. Where a step's record format is open, the signature travels with the record and its reader counts it; where the format is a strict, retained family, the signature is taken before the step runs (a script cannot take the step without the person's touch) and is not yet kept in the record, so a record written by hand in that store is not yet caught, locally or by M4's remote check.

| Step | Applies on | Signed where | Signature kept and counted |
| --- | --- | --- | --- |
| `constitution except` | the Story's pin | `saveWorkflow` (family `constitutionExceptions`) | yes: the review's constitution section counts only a verified exception |
| `decision choose`, and `approve --choose` | the Story's pin | `saveWorkflow` (family `decisionLog`, entries `by: "person"`; a rule's routing is never signed) | kept on the log entry; the route is the Story's state, re-checked by M4 |
| `reopen` | the Story's pin | inside its transaction, M2's machinery on the `reopened` decision | yes, as reject's |
| `story adjudicate` | the Story's pin | before the convergence projection is written (`signPersonRecords`) | not yet: the convergence record is a sealed family |
| `review-source decide` | the Story's pin | where the decision is retained, inside its transaction (§10.7) | yes (§10.7): `source-review-decision` v2 |
| Appeal decisions; quality risk, artifact risk and disputed-finding decisions and their revocations | the Story's pin | where the decision record is written (§10.7); the card-only touch is skipped there | yes (§10.7): `phaseAppealDecisions` (`phase-appeal-decision` v2) and `qualityRiskDecisions` |
| Re-review (re-attestation) of an appeal or a risk; evidence and plan corrections; test attestation and selection, `story test-policy … --apply`, `story approvers refresh` | the card's Story pin, else the repository's policy | in `captureTerminalActionAuthorization`, over the exact card the person confirmed (`signTerminalReview`) | corrections: yes (M3's `planAmendments`); re-review writes no record; the rest not yet (§10.7) |
| `action authorize` (plan actions) | the plan's Story pin, else the repository's policy | in `issueActionAuthorization`, over the exact card | not yet: the authorization is a machine-local token |
| Spec Studio `accept`, `reject`, `decide`, `settle`, `publish`, `discard`; `spec split --publish` | the repository's current policy | before the action (`spec-author.mjs`) | not yet: the library's families are strict |
| `configuration approve`; Epic `approve`, `review approve|reject`, `complete`; `goal plan approve`; `intent ratify|confirm`; `program approve --confirm`; `capabilities lease`; `ledger deployment-check` with a host-policy assertion; `agents lock`; `repair authorize` | the repository's current policy | at the CLI's dispatch, before the handler runs, once per command (`gateRepositoryPersonStep`, routes in `repository-step-routes.mjs`) | not yet: each writes its own store |

- **No Story pin, so the repository's current policy.** A repository-level step follows the approved configuration's signed policy as it stands: on, it needs the signature; off or absent, behaviour is exactly as before. A policy file that exists but cannot be read refuses with `PSS_POLICY_UNREADABLE` and the routes; no file at all is off.
- **Telemetry consent stays unsigned.** `telemetry enable` is this machine's preference, not a governance record; the Copilot guard still refuses it for agents outside `/sf-telemetry`.
- **What stays.** The records marked "not yet" keep their formats, so no schema family changed version. One GDP companion moved, `action-authorization`, for the terminal-review signature (`docs/contracts/gdp/COMPANION-LOCK-REVIEW-2026-11-02-SF-GUARD-PERSON-STEPS.md`). Keeping each signature in its record, counting it at its reader and re-verifying it in the remote check (`story-verify.mjs`) is one family version per row under a lock review: the next milestone.

### 10.7 Retained review decisions (2 November 2026)

The decisions a live terminal review writes now keep their approver's presence signature in the record, so a record written by hand counts for nothing, locally and in the remote check.

- **Which.** A quality risk decision (also an artifact risk or a disputed finding) and its revocation (`qualityRiskDecisions`); an appeal decision (`phaseAppealDecisions`, retained as `appeals/<APL>/decision.json`) together with the plan amendment an `account-scope` decision binds; a source review decision (`context/reviews/<step>/gen-<N>/decisions/<report>/<record>.json`).
- **Signing.** Each is signed where its record is written, inside its transaction and before its origin witness or retained copy, with M3's machinery (`signPersonRecords`): M2's checks in M2's order, every refusal with the person's routes, nothing written on a refusal, and a per-person exception labelled as a bypass. The signature covers the record's own fields, so an edit, or the block carried to another record, breaks it. The review's card-only touch is skipped there (`captureTerminalActionAuthorization(…, { presenceInRecord: true })`), so the person is asked once; an appeal decision and the amendment it binds share that one touch.
- **Formats.** `qualityRiskDecisions` and `phaseAppealDecisions` join M3's families (`PERSON_STEP_FAMILIES`); their item schemas take an optional `presence` block. `phase-appeal-decision` and `source-review-decision` go to v2, written only on a Story with an SF Guard pin, so a repository that never opted in keeps writing v1 (one GDP companion lock review: `COMPANION-LOCK-REVIEW-2026-11-02-SF-GUARD-RETAINED-REVIEWS.md`). A source review decision's presence block is part of the body its `recordSha256` covers.
- **Counting.** On a Story SF Guard requires, each reader counts only a verified or excepted record: the coverage, artifact-risk and finding-dispute statuses read an unsigned decision as `unsigned` and an unsigned revocation as no revocation; the final check lists only counted disputes; an unsigned appeal decision reads `unsigned` and neither accounts for scope (its plan amendment is uncounted too, so the scope gate still sees the change) nor holds the phase; an unsigned source review decision disposes of nothing, so its finding stays open. Accepting a risk whose packet already has an unsigned decision refuses with `PHASE_QUALITY_RISK_UNSIGNED` and the route: a fresh packet (a new reason or expiry), accepted in the person's own terminal.
- **Remote check.** The workflow.json lists are verified with M3's families. A Story's person records kept in their own files are listed in `STORY_RECORD_FILES` (`story-verify.mjs`); the remote check verifies each one a change adds (`PSS_RECORD_UNSIGNED`, `PSS_SIGNATURE_INVALID`, or a note when it is already on the base) and fails a change that removes a signed one (`PSS_RECORD_REMOVED`).
- **Authorship labels.** G3's packet label for a claimed person's or tool's draft now says whether the claim carries its author's signature: "claimed, signed by <ID>", or "claimed, unsigned: treated as agent-written", wherever SF Guard read it.
- **Running Stories.** A risk, appeal or source review decision recorded on a Story pinned `required` before this change carries no signature and now reads `unsigned`; the routes above record it again, signed.

**Still not kept in the record**, each the touch-before-write of §10.6, with its reason:

| Step | Why not yet |
| --- | --- |
| `story adjudicate` | The convergence record is a sealed projection: its findings' transitions (`next`, `blockers`) are recomputed from the adjudications at every integrity check. Counting a signature there needs the projection to take the Story's verdicts, a change to its hash contract (family v4). |
| Test attestation and selection, `story test-policy … --apply`, test-run risk admission, test recovery admission, baseline admission | Each retains its own decision file or workflow snapshot amendment with its own family; each is one family version and one reader, not yet done. |
| `story approvers refresh` | A workflow snapshot amendment; new members still need a pinned key to approve, so an unsigned refresh grants no approval power, but the amendment is not yet signed in its record. |
| `action authorize` | The authorization is a machine-local token, consumed once by the action it names; it is never committed, so it has no remote form to verify. |
| Spec Studio stores; `configuration approve`; the Epic, goal, intent, program, lease, host-policy, agents-lock and repair-authorize stores | Repository-level stores, each with its own format and readers; keeping the signature in each, under the repository's policy at the record's time, is one family per row, not yet done. `configuration approve` also needs the approved configuration's reader to verify the approval behind each `sflow/config` commit, since a commit pushed to that branch directly would otherwise bypass any record. |

### 10.8 Story summaries: test policy, approvers, test selection and test-run risk (2 November 2026)

The Story-level rows §10.7 left now keep their person's presence signature, from one touch, where the record lands in the Story's aggregate.

- **Which.** A test-policy amendment (`story test-policy amend --apply`, summary in `testCommandAmendments`), an approver refresh (`story approvers refresh`, summary in `approverRefreshes`), a test selection confirmation (`story test-policy confirm`, `testRecovery.selectionConfirmations`) and a test-run risk review: an acceptance, re-attestation or revocation (`accept-risk`, `attest-risk`, `revoke-risk`) and a baseline admission re-review (`testRecovery.riskReviews`).
- **Signing.** Each joins M3's families (`PERSON_STEP_FAMILIES`; a family may name a nested `path`), so `saveWorkflow` signs the entry the command added, with M2's checks in M2's order, its routes, and nothing written on a refusal; the live review's card-only touch is skipped (`presenceInRecord: true`), so the person is asked once. A test selection or risk review names no actor: it is the decision of the person running the command, the signature names them, and its verdict counts it only when the signer is one of the Story's approvers (an author's key never is).
- **Seals, not format bumps.** `test-command-adoption-summary` and `approver-refresh-summary` are immutable, exact-key families. Their signature is kept beside the summary as a seal in the Story's `personSeals` (`{ list, id, presence }`; `schemas/workflow.schema.json`), found again by the summary's own digest over the fields the seal lists, never by its ID, so a seal carried to another summary, or a summary edited after signing, counts for nothing. Neither family changed version and no GDP companion moved. The test-recovery entries carry their `presence` block on the entry.
- **Counting.**
  - A test selection counts only when signed (`trp-delivery-selection.mjs`), so an unsigned one confirms no scope.
  - A risk decision that a review entry names counts in the test-recovery gate only while one such entry is signed (`test-recovery-runtime.mjs`). A decision no review names, accepted at intake before the Story existed, keeps today's rule (below).
  - Publication and submission refuse while any test-policy amendment carries no verified signature (`assertSignedTestCommandAmendments`, `PSS_RECORD_UNSIGNED`), naming the person's command. Reading the Story and amending it again are never refused, so the route always works.
  - An approver refresh adds members to groups the Story already has. On a Story SF Guard requires, a member counts only with a pinned key in the approved configuration's chain, so an unsigned refresh grants no approval power by itself; its seal is checked by the remote check. A refresh commit stays review-safe when it adds exactly its own seal (`approval-check.mjs`).
- **Remote check.** All four lists are listed with the Story's person records (`storyPersonRecords`), so a change that adds an unsigned entry fails (`PSS_RECORD_UNSIGNED`) with its route.
- **Running Stories.** An amendment, refresh, selection or review recorded on a required Story before this change reads unsigned; its route records it again, signed.

**Still not kept in the record**, with the reason:

| Step | Why not yet |
| --- | --- |
| `story adjudicate` | The convergence record is a sealed projection recomputed from its adjudications at every integrity check; counting a signature there changes its hash contract (family v4). |
| Test recovery admission at intake | The agreement and baseline risk decisions are reviewed before the Story exists, so there is no Story pin yet; signing them needs the start-time pin threaded into intake and a materialized, signed review entry. |
| Test attestation (`story test-policy attest`) | It restores machine-local review-origin evidence only; it writes no Story, policy or Git record. The amendment it re-attests is signed (above). |
| `action authorize` | A machine-local, single-use token, never committed: there is nothing remote to verify. |
| Spec Studio stores; `configuration approve`; the Epic, goal, intent, program, lease, host-policy, agents-lock and repair-authorize stores | Repository-level stores, each with its own format and readers. Each still takes the person's touch before it runs (§10.6). Keeping the signature in each, and verifying the approval behind each `sflow/config` commit, is the next step. |

### 10.9 Repository records: specification revisions and splits, configuration approvals (2 November 2026)

A repository-level person step has no Story to pin SF Guard's policy, so its record follows the repository's signed policy as it stood when the record was written. Where the record is one the remote can see, its presence signature is now kept beside it as a seal, from one touch over the exact record (`src/presence/repository-seals.mjs`).

- **The seal.** `sflow-presence-seal@1`: the store, the record's key, the record fields the signature covers, their digest (`repositoryRecordSha256`), and M3b's `presence` block over `repositoryStepStatement`. A reader verifies it against the approver's key pinned in the policy chain at the time it was signed (an author's key never signs a repository step), or a per-person exception that held then, never GitHub. An edited record, or a seal carried to another record, counts for nothing.
- **Which record needs one.** A record is checked against the chain's enable and disable events at the time it claims (`recordedAt`, or a configuration commit's committer time): recorded while SF Guard was on, it counts only with a seal that verifies; recorded while it was off, it reads `pre-signing`. The claimed time is the writer's, so a back-dated record is what the state branch check below catches. A repository that never opted in reads every record as before.
- **Specification revisions.** `spec author publish` signs over the revision's manifest digest (which binds every file of the revision), inside `publishRevision`, and publishes `presence.json` in the same state-branch commit as the revision; a retry after another publication moved the branch reuses the same bytes, so there is one touch. The dispatch-time touch for `publish` is gone. Readers: Story start (`resolveSlices`) attaches only a reviewed revision that counts, and without `@N` the highest such one; a named revision that does not count is refused (`PSS_RECORD_UNSIGNED`) with the route, a person publishing it again from its draft. `spec author show` and `list` name the standing.
- **Splits.** `spec split --publish` signs over the split record's digest inside `publishSplit` and publishes `splits/<NNNNNN>/presence.json` with it. A split that does not count allocates no clause in coverage (named there with its route) and reserves no child ID.
- **Configuration approvals.** `configuration approve` signs over the exact proposal it inspected (proposal commit, the `sflow/config` commit it lands on, the proposal branch) after the person confirms and before anything moves; the dispatch gate no longer asks (`inRecord`). Once the proposal is active, the seal is published to the state branch as `singularity/presence-seals/configuration/<proposal commit>.json`, because `sflow/config` may be protected by the Git host. A seal that could not be published leaves the approval standing, with the route: approve the same proposal again, which records it. `configurationApprovalStanding` reads the approved commit as signed when its own commit, or the proposal its activation merge brought in (its second parent), has a seal that verifies; `guard status` shows it.
- **Remote check.** `governance verify --presence --state-records [--base REF]` (`src/presence/state-check.mjs`), which the CI recipe now also runs on every push to the state branch: every revision, split and configuration seal the push adds must verify (`PSS_RECORD_UNSIGNED`, `PSS_SIGNATURE_INVALID`), no seal and no sealed record may disappear (`PSS_RECORD_REMOVED`), and one already on the base that does not verify is only a note. The state branch takes direct pushes, so the failed run is the alarm; the readers above count only verified records whatever it says.
- **Draft-local steps.** Spec Studio's `accept`, `reject`, `decide`, `settle` and `discard` change only this clone's draft; they keep their touch before they run (§10.6), and what they decided reaches the state branch only inside a revision the person publishes and signs.

**Still not kept in the record**, with the reason:

| Step | Why not yet |
| --- | --- |
| Other `sflow/config` writers: capability map publication and activation, approver membership edits, recreate-sync | They write `sflow/config` without `configuration approve`, so the approved commit after one of them reads unsigned under SF Guard. That is why the configuration reader does not yet refuse an unsigned commit: refusing would block those flows. Each writer needs its own person step and seal first. |
| The Epic, goal, intent, program, capability lease, host-policy, agents-lock and repair-authorize stores | Each has its own store and readers; each still takes the person's touch before it runs (§10.6). |
| `story adjudicate`; test recovery admission at intake | As §10.8: a convergence hash-contract change (family v4), and the start-time pin threaded into intake. |
| `action authorize` | A machine-local, single-use token, never committed. |

### 10.10 Repository stores, adjudications and intake (2 November 2026)

Every person step §10.6 to §10.9 left with a touch but no record now keeps its signature with the record, from one touch, and every reader counts only a record that verifies (or that a per-person exception covers, or that was recorded while SF Guard was off: `pre-signing`). The dispatch gate asks no touch of its own any more: every repository-level route signs where it records (`inRecord`).

**Repository stores** (`src/presence/store-seals.mjs`, `STORES`). Each follows the repository's signed policy at the record's own time, as §10.9's seals do (`repositorySealVerdict`, the approver's key pinned in the chain at the time, never GitHub, never an author's key).

| Step | Kept | Reader that counts it | Remote check |
| --- | --- | --- | --- |
| `capabilities lease grant|revoke` | inline: `payload.presence` of the ledger entry, over its event, actor, authority group, payload and time | capability policy resolution (`countedLeaseEntries`, used by `capabilities show` and Story start): an unsigned grant relaxes nothing, an unsigned revocation revokes nothing | state branch (`--state-records`): an unsigned lease entry a push adds fails; a signed one never disappears |
| `repair authorize` | inline: the `repair-authorized` event's `data.presence` | `repair attempt` refuses an authorization that does not count, with the route | none: the repair store is machine-local and never committed (as `action authorize`) |
| `agents lock` | inline: the lock entry's `presence` | every `agents sync` (and so every agent run that materializes dependencies) refuses an entry that does not count | branch: an entry the change adds or edits must verify; a signed entry never disappears |
| `ledger deployment-check` with a host-policy assertion | inline: `confirmation.presence` in the report | no reader consumes the report; it is kept for review | branch: a recorded report (`--record`) the change adds must verify |
| Epic `approve` (`initiative approve`, `epic requirements|planning approve`) | beside: `approvals/records/<sha256>.presence.json`, over the record's exact bytes | `readInitiativeRecords` drops an approval that does not count, so phase readiness, pack and bundle approvals, chains and the summary see only counted ones | branch: an unsigned record or a removed seal fails |
| Epic `complete` | beside: `delivery/records/<sha256>.presence.json` | delivery readiness reads an uncounted completion as still tracking, and `epic complete` can be run again (the route) | branch, as above |
| `goal plan approve` | beside: `approvals/plan-generation-<N>-<sha>.presence.json` on the Goal branch | `goal next` and `goal verify` refuse an approved plan whose approval does not count | branch, as above |
| `program approve --confirm` | beside: `<program>.presence.json`, proposed into `sflow/config` with the record | Program execution admission (`loadApprovedSgosProgramAuthority`) refuses one that does not count | reaches `sflow/config` only through `configuration approve` (§10.9); see below |
| `intent ratify`, `intent confirm` | beside the `--out` file (`<file>.presence.json`); while SF Guard is on, `--out` is required, refused with that route before any touch | `intent compile` refuses a ratification or Intent IR that does not count | none: the files are the person's working copies |
| Epic `review approve|reject` | a Story decision: it now takes the Story's own pin with M2's machinery (`preparePersonPresence`), and the signature is kept in the decision record | the Story's approval readers, as any approval | the Story's records, as M4 |

**`story adjudicate`** (family v4). `convergence-record` goes to v4: a finding's decision may keep its approver's presence block (`findings[].decision.presence`) inside the sealed projection, so the hash contract covers it, and the integrity check rebuilds every adjudication with it (`findingAdjudication`). The step projects first, then one touch signs each new decision exactly as its finding records it, then the projection is written with the blocks. Every new projection is v4: the block is optional, so on a Story SF Guard does not require it is the v3 projection with a new version number, and the v3 to v4 step re-seals an older one on read, so every iteration still replays. (Writing v3 there was not an option: a v3 file read back is re-sealed as v4 under a new hash, which would no longer match the convergence artifact that names it.) Readers decide on `countedConvergence`: on a Story SF Guard requires, a finding whose signature does not verify reads as undisposed, its blockers and next steps are recomputed without it, `story advance` and publication refuse with `adjudicate` as the route, and rework and intent amendments see only counted findings. The sealed projection itself is never rewritten by a reader. One GDP companion lock review: `COMPANION-LOCK-REVIEW-2026-11-02-SF-GUARD-ADJUDICATIONS.md`.

**Test-recovery admission at intake.** The Story's SF Guard pin is now taken before the intake review (`createWorkflow`), so the review runs on it: the agreement and each accepted baseline risk decision get a review entry in the new Story (`testRecovery.riskReviews`, action `intake-accepted`), signed with one touch before anything is written (the card-only touch is skipped). On a Story SF Guard requires, a risk decision counts in the test-recovery gate, and an intake decision admits feature work, only while a review entry naming it is signed; the route for one that is not is its re-review, `story test-policy baseline-admission … --apply`. A Story without a pin reads every intake decision as before.

**What a record's time means.** As in §10.9, the time a record claims is the writer's. For the state branch and committed stores, the remote checks fail what a change adds; for a machine-local repair store and an intent's working copy there is no remote form, and a record claiming a time before the opt-in reads `pre-signing` there.

**Running repositories.** A lease, approval, completion, plan approval, lock entry or adjudication recorded while SF Guard was on, before this change, carries no signature and now counts for nothing; each refusal names the command that records it again, signed. A Story pinned before this change whose intake decisions have no review entry needs their re-review.

#### 10.10.1 `sflow/config` writers: options (open decision)

`configuration approve` keeps a seal (§10.9), but readers of the approved configuration do not yet refuse an unsigned approved commit, because other writers move `sflow/config` with no person step. Each writer is one of:

| Writer | Today | Class |
| --- | --- | --- |
| `configuration approve` (merge of a reviewed proposal) | sealed | (a) a person's signed approval |
| `workflow activate --confirm <commit>` | the same merge as `configuration approve`, unsigned | (a), not yet signed |
| `capability activate` (merge of a capability-map proposal) | `--confirm`, unsigned | (a), not yet signed |
| `capability setup-activate` (fast-forward to a setup proposal) | `--confirm`, unsigned | (a), not yet signed |
| `configuration recreate-sync --apply` | a digest confirmation, unsigned | (a), not yet signed |
| `configuration publish` (commit and push the checked-out branch, which may be `sflow/config`) | no confirmation | (a), not yet signed |
| `workspace refresh-configuration` (packaged configuration of the installed product) | `--confirm-plan` when given | (b) derived from the product, with no signed input |
| Approver membership enrollment (`configuration add-current-identity`, and automatically on every Story start unless `autoEnrollNewIdentities: false`) | no person step | (b) derived from the person's Git identity, with no signed input |
| Creating `sflow/config` (`bootstrap`, `onboard`, workspace initialization, the first capability map, a fresh capability onboard) | before any policy exists | (b) the root, before opt-in |

The two decisions this needs are product decisions, not settled by this specification:

1. **Automatic enrollment.** It runs on every Story start and adds an approver with no person step. Options: (i) while SF Guard is on, stop automatic enrollment, so enrollment is `configuration add-current-identity` signed by an existing approver; (ii) keep it as a derived, membership-only publication: the reader accepts a commit whose change is exactly a member added to an existing group, on top of a counted commit, because under SF Guard a member counts only with a key pinned by a signed chain event, so the addition grants no approval power by itself (the §10.8 reasoning for approver refreshes); (iii) both, by repository setting.
2. **Packaged refresh.** It is derived from the installed product, not from a signed input. Options: (i) route it through a configuration proposal that a person approves (`configuration approve`, sealed); (ii) seal the refresh plan at `--confirm-plan` as a person step, which then requires `--confirm-plan` while SF Guard is on.

**Recommendation.** Option (ii) for enrollment and option (i) for packaged refresh, and sign every class (a) writer at its own confirmation with the configuration seal of §10.9, keyed by the commit it produces. Then the reader, while SF Guard is on, walks `sflow/config` back from the tip to the newest commit with a seal that verifies, and accepts every commit after it only when it is a membership-only enrollment; anything else is refused with `PSS_RECORD_UNSIGNED` and a route a person can take that day: an approver approves the current configuration, a new `configuration approve --current` that seals the tip after showing its diff from the last counted commit. That command does not exist yet, so the reader cannot refuse until it does. Until this is decided, rows 1 to 3 above are built and the reader stays as §10.9 left it: `guard status` names an unsigned approved commit, and nothing refuses it.

### 10.11 M5 as built (2 November 2026)

- **The sign card** (`apps/vscode/src/views/sf-guard.ts`, `SfGuardSignPanel`). A model-free person step VS Code runs (Approve, Reject, Close gap with O1 and sign and the other Spec Studio steps) goes to the CLI unchanged. Without a terminal the CLI refuses it with `PSS_CARD_NOT_SHOWN` before anything is written. The runner keeps the refused command on its `CliError` (`invocation`: repository and arguments, never the environment). `showRefusal`, and Spec Studio's own refusal path, hand that one code to the sign card instead of a refusal card. Every other refusal, `PSS_SIGNER_UNAVAILABLE` included, stays the ordinary card with the CLI's routes.
- **What the person does.** The card shows the step, the exact command (a receipt token reads `<receipt>`), the repository and REQ-012's rule. **Open my terminal to sign** opens the person's own terminal in that repository and types the same command, without `--json` and without running it. The person presses Enter, so the command is one they started. That process prints its card and takes the touch (REQ-012 mitigations 1 and 2). The bundled engine runs as Node through the terminal's own environment option, never through a variable written into the command. A card whose repository is no longer the extension's refuses to open a terminal.
- **Agents stay refused.** Only a click on the card's page opens the terminal. No language-model tool or Copilot message reaches it, and the CLI still refuses an agent's process by its markers.
- **The first-run card.** The Guard page and the first sign card explain the flow and carry the rule. The page's card is dismissed with **Got it**, and the first terminal handoff counts as seen. The flag is kept in this machine's VS Code state (`singularityFlow.sfGuard.firstRunSeen`), never in the repository.
- **The Guard page** (`Singularity Flow: SF Guard`). It reads `guard status --json` and `guard report --json`, the terminal's readers. It shows on or off, the policy chain, each registered key with its expiry, exceptions labelled "bypass: per-person exception EXC-…", the remote check with branch protection, the recipe route (`guard remote-check --recipe > .github/workflows/sf-guard-verify.yml`, and the recipe itself from `guard remote-check --json` on request), recording, and labels by Story and step (`guard report --story`).
- **Key expiry.** `guard status` now gives each approver row an `expiry`: `{ here, validTo, valid, reason }`, from this Mac's `sc_auth list-ctk-identities -t ssh`, which is an inspection with no prompt and is read only when a key is pinned. Another computer, or a key this Mac does not hold, reads `here: false` with the reason, and the page says the expiry is read on the Mac that holds it. An expired key names the rotation route.
- **Story, approval and review views.** For a Story that pinned SF Guard (`resolution.presence`), the Story view and the approvals view read `approvals <WORK-ID> --json` and `guard report --story <WORK-ID> --json` once per change of the Story's approvals or submissions. Each approval then shows the verifier's label as a pill: signed, pre-signing, bypass or not counted. The phase shows its packets' attribution summary (the approval card's line) and labels. The approval review page shows the packet's summary and labels from `review --format json`, and the step's recorded decisions with their standing. A Story that did not pin SF Guard reads nothing new and shows nothing new.
- **Tests.** `test/vscode-sf-guard.test.mjs` covers the model, the pages and the panels against the real `guard status` of an opted-in repository. `test/vscode-host.test.mjs` takes an approval through the built extension: the review, the refusal, the card, then the terminal. `test/vscode-spec-studio.test.mjs` covers Close gap with O1 and sign handing its refusal to the card. The bundle ceilings rose by the measured modules only: `extension.cjs` 151 to 152, `lazy-panels-runtime.cjs` 300 to 303.

## 11. Acceptance criteria

| ID | Scenario | Observable result |
| --- | --- | --- |
| [PSS:AC-001] | A member registers a `p-256-ne`/`bio` identity that is listed on their GitHub account | A `register` event signed by that key, with a GitHub snapshot digest; the fingerprint matches `sc_auth list-ctk-identities -t ssh`; the chain names no email or login |
| [PSS:AC-002] | A software key is written into the policy file directly, or the key is not on GitHub | Not trusted: the fold stops at it (`PSS_POLICY_UNSIGNED`) or registration refuses (`PSS_KEY_NOT_LISTED`) |
| [PSS:AC-003] | A key whose private half is in `~/.ssh`, at an `IdentityFile` path, or loaded as a plain key in `ssh-agent` | `PSS_KEY_READABLE` at registration |
| [PSS:AC-004] | A key that is not a `p-256-ne`/`bio` identity on this Mac, or one whose certificate expired | `PSS_KEY_NOT_PRESENCE`, or `PSS_KEY_EXPIRED` with the rotation route |
| [PSS:AC-005] | A lost key: recovered after GitHub drops it, rotated with both keys, or revoked by another approver | The new key is pinned and labelled recovered; recovery is refused while GitHub still lists the old key; earlier events still verify |
| [PSS:AC-006] | `approve --yes` from a script, a pty or an agent's shell on an opted-in repository | The card, then the Touch ID prompt. Without the touch nothing is written (`PSS_PRESENCE_DECLINED`) |
| [PSS:AC-007] | An approval written with plain Git, reusing a real signature from another record | `PSS_SIGNATURE_INVALID`: the statement doesn't match the record. It doesn't count |
| [PSS:AC-008] | A Story started while `off`, approved unsigned, then continued after opt-in | Earlier approvals count as `pre-signing`; later steps follow the pinned policy |
| [PSS:AC-009] | Windows, Linux, CI or an Intel Mac without T2 runs `approve` on an opted-in repository | `PSS_SIGNER_UNAVAILABLE` before any write, naming the routes; with an active exception the record is labelled "bypass: per-person exception EXC-…" |
| [PSS:AC-010] | Each §3 row, run unsigned on a `required` Story | Refused or not counted, by its named reader |
| [PSS:AC-011] | A clone whose SFlow verifier was patched pushes a forged approval | The remote check fails and branch protection blocks the merge; an unmodified clone refuses it |
| [PSS:AC-012] | An unsigned or agent-signed `disable`, an edited `enable`, or a commit that deletes the policy file | SF Guard stays on; `guard status` names `PSS_POLICY_UNSIGNED` or `PSS_POLICY_REWRITTEN`; Studio refuses to write such a chain |
| [PSS:AC-013] | Receipt replay of a Story with signed approvals | Every signature is re-verified, under 50 ms per Story |
| [PSS:AC-014] | VS Code "Close gap with O1 and sign" | The card, then the prompt, then the signed event |
| [PSS:AC-015] | The signed opt-in names a per-person exception for a Windows approver; later revoked | Their standing reads "bypass: per-person exception EXC-001" until a signed `exception-revoke`; an agent cannot add one |
| [PSS:AC-016] | `guard register` while GitHub is unreachable, and `guard status` in a repository that never opted in | `PSS_ANCHOR_UNAVAILABLE` with nothing recorded and "run the same command again"; status reads off with no file written and no problem |

## 12. Decisions

| # | Choice | Decided (1 November 2026) |
| --- | --- | --- |
| Q1 | Trust anchor | The approver's GitHub-listed SSH signing key, read at registration, plus a required remote check. Verification reads only the pinned keys |
| Q2 | Mac signer | The built-in `sc_auth` identities with OpenSSH. No helper. The prompt can't name the action (REQ-012) |
| Q3 | Rollout | Opt-in per repository. Turning it off or weakening it must be signed. Not opting in changes nothing |
| Q4 | Windows | Deferred. A Windows approver in an opted-in repository gets a signed per-person exception, labelled as a bypass for that person |
| Q5 | Blocking | "Nothing should get blocked": no refusal without a route a person can take today; GitHub is never needed to verify; an invalid policy file never blocks (REQ-042) |
| Q6 | Name | SF Guard: `singularity-flow guard`, `/sf-guard` (status only), the `sf-guard` topic; codes keep `PSS_` |

The no-touch-window question (REQ-013) fell away: M0 measured a fresh prompt for each signature.

## Sources

- GitHub REST API documentation, "SSH signing keys" (the public list, and the `write:ssh_signing_key` scope needed to add one)
- GitHub CLI manual, `gh auth login` (token scopes)
- macOS 26 Secure Enclave SSH keys with `sc_auth` and `ssh-keychain.dylib`: community write-ups only; no Apple documentation was found
- `man sc_auth` and `man ssh-keygen` on macOS 26.7.1 (OpenSSH 10.3p1); OpenSSH PROTOCOL.sshsig and PROTOCOL.u2f
- Windows (deferred): Microsoft's `Windows.Security.Credentials.KeyCredential` documentation; "Abusing Windows Hello Without a Severed Hand" (DEF CON 32)
