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
  - inbox
related:
  - waivers
  - inbox-and-review
  - sequence-gates
version: 6
---
Approval is an authorization event, never an agent utterance. Authority comes from `approvalAuthorities` groups in pinned configuration; the ceremony shows the exact artifact and its SHA-256, then requires typing the exact confirmation — nothing auto-fills it. The record binds identity, authority group, and artifact hash, verifiable offline. If artifact bytes change afterward, the approval goes stale automatically; the old signature remains in history attached to the bytes it actually covered. Agents cannot approve. Normal team configuration defaults self-approval and first-use identity enrollment on; both are explicit `approvalSecurity` switches in **People & approvals**, while the regulated profile defaults them off. Rejections require reasons — which become pinned context the next generation literally reads.

## Purpose and prerequisites

Use this topic when the current goal matches **approvals**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** `sflow approvals [WORK-ID]` shows the phase-by-phase document and approval chain. `sflow approve`, `sflow reject`, and `sflow inbox` perform or find review work. Run `singularity-flow approvals --help` for the exact read-only form supported by this build.
- **Copilot:** `/sf-approve`, `/sf-reject`, `/sf-inbox`. `/sf-approve` first resolves the requested Work ID and submitted phase, hash-checks that exact review packet, and reproduces every generated text artifact in the visible Copilot response. Only after the complete artifact display may it ask for the exact phase confirmation. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** open Singularity Flow **Inbox and Approvals**. The extension renders engine results; it does not independently decide lifecycle state.

## Guided workflow

1. Read the current state with `sflow home`, `sflow status`, or `sflow approvals [WORK-ID]` to see every phase document, authority group, threshold, and recorded approver.
2. Review the repository, workspace, Work ID, phase, actor, and any warnings before selecting an action.
3. Preview or prepare the operation when the command offers a dry-run, plan, packet, or exact confirmation.
4. Run the smallest applicable command from this topic. Do not substitute an undocumented subcommand.
5. Re-read state after completion. In Copilot, return to `/sf-home`; in VS Code, refresh the relevant view if it has not already refreshed.

## State and safety

These commands can mutate governed or machine-local state: `approve`, `reject`. They remain subject to identity, authority, sequence, freshness, branch, worktree, and exact-confirmation checks. Signed handles are session-bound and are never shared between the shell, Copilot, and VS Code. Durable repository and workspace records are the shared source of truth.

## Troubleshooting

- If the selected Story or branch is wrong, stop and use `sflow home`, `sflow session`, or `sflow workspace list` before retrying.
- If a command refuses because state moved, refresh and use the newly rendered action instead of replaying an old handle or confirmation.
- If publication or synchronization is pending, follow the exact recovery command in the refusal and verify with `sflow doctor`.
- If a Copilot or VS Code action is unavailable, use the displayed CLI fallback; do not guess a command from the label.

## Related topics

Continue with `sflow explain waivers`, `sflow explain inbox-and-review`, `sflow explain sequence-gates`.
