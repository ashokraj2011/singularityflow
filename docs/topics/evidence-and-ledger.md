---
id: evidence-and-ledger
title: Evidence, the ledger, and traceability
aliases: [ledger, worldline, trace, audit]
commands: [ledger, spec]
related: [approvals, impact-framework]
---
Everything consequential is hash-linked: artifacts, inputs, approvals, checks, receipts. The append-only capability ledger mirrors lifecycle events as a tamper-evident chain; `sflow ledger verify` validates it from a bare clone, offline. `sflow spec index/coverage/trace` gives requirements stable clause identities and walks requirement → claim → commit → test evidence → approval. Mechanical coverage never claims semantic correctness — judgment and evidence are both retained and never confused. For auditors, fieldwork starts with `git clone`.
