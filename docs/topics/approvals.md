---
id: approvals
title: Approvals
aliases:
  - approve
  - approval-ceremony
  - stale-approval
questions:
  - How do approvals work?
  - What must be decided before this step can be approved?
  - Why is my approval stale?
  - What command approves a phase?
keywords:
  - reviewer authority
  - self approval
  - product approvers
  - decision list
commands:
  - approvals
  - approve
  - reject
  - upstream-issue
  - decisions
  - inbox
related:
  - waivers
  - inbox-and-review
  - sequence-gates
version: 16
---
Approval is an authorization event, never an agent utterance. Authority comes from `approvalAuthorities` groups in pinned configuration; the ceremony shows the exact artifact and its SHA-256, then requires typing the exact confirmation — nothing auto-fills it. The record binds identity, authority group, and artifact hash, verifiable offline. If artifact bytes change afterward, the approval goes stale automatically; the old signature remains in history attached to the bytes it actually covered. Agents cannot approve. Normal team configuration defaults self-approval and first-use identity enrollment on; both are explicit `approvalSecurity` switches in **People & approvals**, while the regulated profile defaults them off. Rejections require reasons — which become pinned context the next generation literally reads.

## Purpose and prerequisites

Use this topic when the current goal matches **approvals**. Start in a repository that uses Singularity Flow unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow approvals [WORK-ID]` shows the phase-by-phase document and approval chain. `sflow approve`, `sflow reject`, and `sflow inbox` perform or find review work. Run `singularity-flow approvals --help` for the exact read-only form supported by this build.
- **Copilot:** `/sf-approve [PHASE-ID] [--work-id WORK-ID]`, `/sf-reject`, `/sf-inbox`. The positional approval argument is a phase, not a Story ID. Chat shows summaries, document identities/hashes and verified Markdown-preview links, not artifact or code bodies. The human reviews the complete exact-bound documents outside chat. Same-chat human acknowledgement can be reused only with matching non-null `displayBinding` and unchanged `reviewBinding`; summaries and opened previews do not prove review. Submission and approval obtain a fresh binding for the immutable approval packet. New chat, changed/null bindings or incomplete material require fresh human review. Require an explicit human `/sf-approve <PHASE-ID>` or exact phase answer after the current packet review; review reuse never reuses consent. Do not ask the same confirmation again for an unchanged reviewed packet. Identity, authority, receipt freshness and single consumption remain enforced.
- **VS Code:** open Singularity Flow **Inbox and Approvals**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or `sflow approvals [WORK-ID]` to see every phase document, authority group, threshold, and recorded approver.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Approval automatically advances and activates the next phase when the configured threshold is met. It may instead wait for other reviewers or a workflow decision. Report the actual result; do not issue another advance command. Next-phase authoring is a separate action. In VS Code, refresh the relevant view if it has not already refreshed.
6. A later step that finds a defect in an earlier, approved step raises it with `sflow upstream-issue raise --phase EARLIER --about ID --problem TEXT`, or `--from-artifact` for the items its own artifacts list under `## Upstream discrepancies`. Raising never stops the current step. The earlier step's approvers decide it with `sflow upstream-issue decide UPI-NNN`: a plan correction (`sflow decision plan --replace-location ...`, or `--set-fulfillment <CLAUSE>=test-only` when a Story's tests are its whole delivery), a return to that step (allowed while the current step is still in progress), an accepted risk that expires, or a dismissal. The Story completes only when every issue is decided.
7. **The decision list.** When a step cannot be approved yet because people still have to decide something, `sflow decisions [WORK-ID]` (Copilot: `/sf-decide WORK-ID`) shows all of it in one place, in plain words, as choices: a partial or missing verdict together with the upstream issue that names it (one item, not two), an open upstream issue the Story cannot finish without, a screen size enforced visual coverage still lacks (capturing it is your action, shown with its command and never recorded by the list; saying it does not apply to this Story is the decision), and a test command that could not run here. Each item says why it waits from recorded facts, which option is recommended when the facts make it safe (reusing an earlier step's recorded run only when one exists and the code is unchanged), exactly what each option records, any date or reason it needs (with an editable default), and who decides it. `sflow decisions record [WORK-ID]` asks for each choice in an interactive terminal, shows a one-screen summary and records them after one confirmation; scripts pass `--choose d1=reuse ... --confirm sha256:DIGEST`. Every choice is still a person's decision, checked against their approval group and kept in the history; an item you may not decide names who does and the line to share (`/sf-decide WORK-ID`). A changed list refuses the old confirmation. A superseded upstream issue is never listed and never blocks; its replacement carries it. Approval refusals for pending decisions lead with one sentence ("Release can't be approved yet: 1 decision needed.") and this list. The list is also the one place for everything else that waits on the Story: the routing decision, intent amendments to decide or acknowledge, forward amendments and their revalidations, appeals, sign-offs and scope items owed to the ending, each refusal the approval check names (a TRP or quality risk, a lapsed test-run risk), and a commit or upload that did not publish (its route is `sflow sync`). Each of these is your own step, shown with its exact command and who takes it. The step's approval is always the last item, so the first open item is what to do next. `sflow nextsteps`, `sflow status --submission-readiness`, and the VS Code Inbox, Reviews, Navigator badge and journey all show the same open count.
8. **One approval ceremony.** Review, decide, confirm once. Decisions that hold the step and that you may make are asked in the approval itself (the terminal asks them before the typed phase; the VS Code approval form shows them under "Decide in this approval"; scripts pass `--choose ITEM=OPTION` with the list's `--decisions sha256:DIGEST`), and they are recorded in the approval's own commit, so there is one commit and one push. A return is not an approval, so it is decided from the list. In a terminal, `sflow approve <PHASE>` after that terminal showed the review (`sflow phase show`, or an earlier `sflow approve`) is the confirmation: you type the phase once. A selection receipt holds the review it was opened for with no time limit; a long review still approves, and only a changed review is refused. In Copilot, `/sf-decide` continues into the approval in the same turn when only the approval is left.
8. An approved document step can be corrected without re-running it: `sflow upstream-issue propose-amendment --phase EARLIER --reason TEXT` saves the corrected bytes (the edited artifact, or a `--file` draft), and that step's approvers install them as its next generation with `sflow upstream-issue decide-amendment FAM-NNN --decision approve --confirm FAM-NNN`. Approved later steps that read it keep their approval; each step's approvers record `sflow upstream-issue revalidate STEP --amendment FAM-NNN --outcome unchanged`, or `return` to redo it. Steps that define clauses use intent amendment; plans use `decision plan` corrections.

## State and safety

These commands can change repository or machine-local state: `approve`, `reject`, `decisions record`, `upstream-issue raise`, `upstream-issue decide`, `upstream-issue propose-amendment`, `upstream-issue decide-amendment`, `upstream-issue revalidate`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain waivers`, `sflow explain inbox-and-review`, `sflow explain sequence-gates`.
