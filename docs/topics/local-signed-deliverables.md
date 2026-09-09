---
id: local-signed-deliverables
title: Local signed deliverables
aliases:
  - local-mode
  - repository-free-work
  - signed-local-bundle
commands:
  - local
related:
  - local-work-journal
  - model-independence
  - evidence-and-ledger
  - resets-and-cleanup
version: 1
---
Local mode handles bounded work when no product repository, workspace, network, model, AST index, or world model is available. It stores one private Local Story under the machine-local SFlow data directory and can publish a deterministic, Ed25519-signed bundle after explicit review.

## Purpose and prerequisites

Use Local mode for a bounded deliverable that must remain independent of a product repository. Supply an explicit intent, classification, and one or more absolute input paths. The supported L1 flow needs only local filesystem access and Git for the private append-only ledger; it does not require a workspace, active Story, network, model, AST index, or world model.

## Use it from each surface

- **Shell:** use `sflow local start`, `sflow local status`, `sflow local freeze`, `sflow local verify`, `sflow local signer-create`, `sflow local trust-export`, `sflow local review`, `sflow local publish`, and `sflow local audit`.
- **Copilot:** invoke `/sf-local`. The model-free skill resolves the private Local Story boundary, presents exact commands for review, and never searches for a repository.
- **VS Code:** open the Help Center and search for **Local signed deliverables**. The first release documents and diagnoses the same CLI flow; it does not expose a separate mutation panel that could bypass the explicit confirmations.

## Guided workflow

1. Start with `sflow local start` and explicit intent, classification, and input paths. SFlow copies exact ordinary-file bytes into private storage; it refuses links, special files, path collisions, and inputs that change during capture.
2. Write results only in the returned output directory. Run `sflow local freeze` to seal the candidate and `sflow local verify` with its exact digest to record the built-in exact-tree witness.
3. Use `sflow local signer-create` once for a Local Story. Export only the public trust key with `sflow local trust-export` so an auditor can establish trust independently.
4. Approve the exact candidate with `sflow local review`. This is an explicit standalone self-review under the pinned L1 policy; it is not independent peer review.
5. Publish with `sflow local publish`. Publication is create-only, journaled before the filesystem mutation, verified after writing, and safe to retry with the same inputs.
6. On another offline machine, run `sflow local audit` with the bundle, public trust key, and signer ID. The auditor reads the archive without extracting it and reports integrity, signature trust, evidence binding, historical policy, completeness, and rerun status separately.

Use `/sf-local` in Copilot for the same deterministic CLI path. The skill never invokes a model and never searches for a repository.

## State and safety

The built-in witness proves that the frozen output tree is byte-for-byte present and unchanged. It does not prove that the output is correct for its business purpose. L1 also does not prove delivery, re-execution, external verifier identity, or current permission. Those states remain explicit instead of being collapsed into a single “verified” label.

Remote-device exchange, repository adoption, external verifier receipts, and rerun execution are later levels and are deliberately refused by this implementation. The authoritative scope and examples are in `docs/LOCAL-SIGNED-DELIVERABLES.md`.

The private ledger records prepared and completed publication operations. Repeating the same publish command reconciles an identical destination; an occupied destination with different bytes is refused. Local mode never deletes or changes a product repository, never writes its private signing key into a bundle, and performs offline audit with no network access.

## Troubleshooting

- If a command cannot find the Local Story, run `sflow local list --json` and copy the exact opaque Story ID. Local mode does not infer one from a workspace or chat history.
- If freeze reports an empty output, add the intended files or deliberately pass `--allow-empty-output` after reviewing the outcome.
- If verification reports changed bytes, freeze a new generation; do not edit the retained candidate or its records.
- If trust is unavailable on the audit machine, export the public key with `sflow local trust-export` and establish its signer ID through an independent channel. Never copy the private key.
- If publication was interrupted, repeat the exact publish command. SFlow reconciles only an identical destination and refuses conflicting bytes.
- If the archive fails audit, preserve it as evidence. Audit reads without extracting and does not repair or reinterpret damaged bytes.

## Related topics

Continue with `sflow explain local-work-journal`, `sflow explain model-independence`, `sflow explain evidence-and-ledger`, or `sflow explain resets-and-cleanup`.
