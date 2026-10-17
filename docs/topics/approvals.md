---
id: approvals
title: Approvals
aliases:
  - approve
  - approval-ceremony
  - stale-approval
questions:
  - How do approvals work?
  - Why is my approval stale?
  - What command approves a phase?
keywords:
  - reviewer authority
  - self approval
  - product approvers
commands:
  - approvals
  - approve
  - reject
  - upstream-issue
  - inbox
related:
  - waivers
  - inbox-and-review
  - sequence-gates
version: 12
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
6. A later step that finds a defect in an earlier, approved step raises it with `sflow upstream-issue raise --phase EARLIER --about ID --problem TEXT`, or `--from-artifact` for the items its own artifacts list under `## Upstream discrepancies`. Raising never stops the current step. The earlier step's approvers decide it with `sflow upstream-issue decide UPI-NNN`: a plan correction (`sflow decision plan --replace-location ...`), a return to that step (allowed while the current step is still in progress), an accepted risk that expires, or a dismissal. The Story completes only when every issue is decided.
7. An approved document step can be corrected without re-running it: `sflow upstream-issue propose-amendment --phase EARLIER --reason TEXT` saves the corrected bytes (the edited artifact, or a `--file` draft), and that step's approvers install them as its next generation with `sflow upstream-issue decide-amendment FAM-NNN --decision approve --confirm FAM-NNN`. Approved later steps that read it keep their approval; each step's approvers record `sflow upstream-issue revalidate STEP --amendment FAM-NNN --outcome unchanged`, or `return` to redo it. Steps that define clauses use intent amendment; plans use `decision plan` corrections.

## State and safety

These commands can change repository or machine-local state: `approve`, `reject`, `upstream-issue raise`, `upstream-issue decide`, `upstream-issue propose-amendment`, `upstream-issue decide-amendment`, `upstream-issue revalidate`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain waivers`, `sflow explain inbox-and-review`, `sflow explain sequence-gates`.
