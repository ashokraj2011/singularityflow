---
id: revision-feedback-attachments
title: Revision feedback attachment staging
aliases:
  - revision attachments
  - feedback document staging
commands:
  - revision
related:
  - copilot-and-surfaces
  - artifacts-and-generation
version: 4
---
`singularity-flow revision attachments` stages verified local files as feedback evidence for the selected Story and active phase. This is the attachment-intake slice only: it does not open or execute a REV loop, invoke a model, amend approved intent, or publish a candidate. A deterministic route and packet kernel exists, but mutating REV execution remains disabled until durable interval, recovery, and publication guarantees are implemented and witnessed.

## Purpose and prerequisites

Use this topic when attaching a file to feedback about the current Story phase. The Story session and phase must be active. This evidence class is separate from ordinary Story documents and their phase gates; it is not a way to replace approved requirements.

## Use it from each surface

- **Shell:** `singularity-flow revision attachments capabilities --json` reports the current format and host-bridge support. Use `singularity-flow revision --help` for exact forms. Prefer `--feedback-stdin` so the feedback is not exposed in process arguments.
- **Copilot:** `/sf-revision-attachments` (or `/sflow-revision-attachments`) guides preview, explicit confirmation, and registration. In VS Code, `@sflow /attachments` accepts 1–5 genuine local `file:` references alongside authored feedback, selecting each whole file. Its button opens a separate modal confirmation before registration. `@sflow /attachments status` shows active/revoked set digests, and `@sflow /attachments remove sha256:<SET>` opens reviewed exclusion. Opaque chat uploads and model summaries have no verifiable original bytes and report `REV_CHAT_ATTACHMENT_UNAVAILABLE`; use an explicit local path instead.
- **VS Code:** open the exact active Story worktree; the selected editor repository and ready session must match. The confirmation button registers local evidence only. It does not start a revision or approve or publish anything. Do not use ordinary Story document upload as a substitute.

## Guided workflow

From an active Story session and phase, preview the explicit local file, inspect the returned plan digest, then confirm that exact plan:

```bash
singularity-flow revision attachments preview --file review.md --feedback "Use the existing parser" --json
singularity-flow revision attachments register --file review.md --feedback "Use the existing parser" --confirm sha256:<PLAN> --json
singularity-flow revision attachments list --json
singularity-flow revision attachments status --json
```

To attach several local documents, repeat `--file` (up to the reported per-feedback limit). By default all supplied files are selected. Use one-based `--select 2` to select only the second supplied file; repeat `--select` for more files. For text documents, `--line-range 2:5-12` restricts the selected rendition of file 2 to those lines. Preview and register must use the same ordered files and selections.

The literal `--feedback` form is compatible but can expose private feedback through shell history or process listings. For private feedback, send the **same exact bytes** to both commands through standard input instead, for example `printf '%s' "$REV_FEEDBACK" | singularity-flow revision attachments preview --file review.md --feedback-stdin --json`; use the matching `register` command with `--feedback-stdin` and the returned `--confirm` digest. The VS Code preview route uses standard input automatically.

Preview validates the file and stages a short-lived private plan in the repository's common Git directory; it changes no Story lifecycle state, worktree file, or Git ref. Review the returned file name, media type, byte count, original SHA-256, extraction status, selected state, exact Story/phase and feedback binding, and plan digest before confirming registration. Register rereads the file and rejects changed bytes, feedback, source revision, configuration, workflow, phase, or plan. Listing returns registered attachment-set receipts; registration itself still does not start a revision. Local evidence survives linked-worktree handoff but is **not pushed to Git or shared across laptops**; keep the source file until a governed REV publication path is available.

To exclude a registered set from future routing, first run `singularity-flow revision attachments remove-preview --attachment-set sha256:<SET> --json`. Review its exact plan, then run `singularity-flow revision attachments remove --confirm sha256:<PLAN> --json`. `status` reports active or revoked sets. Its `objectIntegrity: not-checked` field means this fast metadata view is not a byte-integrity check; evidence reads verify the exact selected bytes, and `list` checks every registered object. Removal appends a private revocation; it does not delete the original proof bytes or rewrite historical receipts. To replace a set, register a newly reviewed set first, then explicitly revoke the old one. This is two reviewed operations, not an atomic replacement; if either fails, inspect `status` before retrying.

## State and safety

Only formats returned by `capabilities` are accepted. `.txt`, `.md`, `.json`, `.csv`, and `.tsv` receive bounded UTF-8 renditions; CSV/TSV rows retain source provenance. PDF, DOCX, and image registration remain disabled in the product until approved, policy-pinned scanner and extractor providers are configured. The tested provider interface is not itself production malware clearance. File content and metadata remain untrusted data, not instructions or approved requirements. Do not recreate a file from a model summary. Copilot may have processed a chat attachment before SFlow runs; SFlow cannot retroactively govern that host handling.

## Troubleshooting

If native Copilot bytes are unavailable, use the explicit local-file path. If the selected Story or phase changed, reselect it and preview again; never replay an old confirmation. Unsupported, oversized, non-UTF-8, or secret-bearing files are refused rather than summarized into substitute evidence. The full `/sflow-revise` execution route is not installed in this slice.

## Related topics

Continue with `sflow explain copilot-and-surfaces` and `sflow explain artifacts-and-generation`.
