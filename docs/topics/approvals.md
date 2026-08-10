---
id: approvals
title: Approvals
aliases: [approve, approval-ceremony, stale-approval]
commands: [approve, reject, inbox]
related: [waivers, inbox-and-review, sequence-gates]
---
Approval is an authorization event, never an agent utterance. Authority comes from `approvalAuthorities` groups in pinned configuration; the ceremony shows the exact artifact and its SHA-256, then requires typing the exact confirmation — nothing auto-fills it. The record binds identity, authority group, and artifact hash, verifiable offline. If artifact bytes change afterward, the approval goes stale automatically; the old signature remains in history attached to the bytes it actually covered. Agents cannot approve; self-approval can be forbidden by policy. Rejections require reasons — which become pinned context the next generation literally reads.
