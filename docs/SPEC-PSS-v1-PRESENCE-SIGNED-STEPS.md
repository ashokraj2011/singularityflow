# SPEC-PSS v1 — SF Guard: presence-signed person steps

**Status:**
- **Decided:** 1 November 2026 (§12).
- **M0:** run by the person on 1 November 2026 (§10.1).
- **M1:** built. It covers the verifier, the signed policy chain, key pinning with its GitHub anchor, the opt-in, per-person exceptions, `singularity-flow guard` and `/sf-guard`.
- **M2:** built (§10.2). Approve and reject are presence-signed on a Story SF Guard requires, and only a verified or excepted approval counts.
- **M3 to M5:** not built.

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
| M5 | VS Code surfaces, the first-run card with REQ-012's rule | AC-014 |

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
- **Not signed in M3, with why.** Each of these rows writes outside the Story's `workflow.json`, or has no Story pin to require it. Each needs its own record format, and most need a schema family version under the GDP lock review:
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
