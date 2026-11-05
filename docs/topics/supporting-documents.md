---
id: supporting-documents
title: Supporting documents
aliases:
  - story-documents
  - document-upload
questions:
  - How are uploaded documents used?
  - Where are Story documents stored?
  - Which phases use a document?
keywords:
  - attachment
  - document name
  - this machine only
  - docx
  - xlsx
commands:
  - documents
  - review-source
related:
  - starting-work
  - artifacts-and-generation
  - specification-quality
  - epics-and-planning
version: 13
---
Supporting documents are the evidence a Story is built from: a brief, API notes, a spreadsheet of rules, a design export or screenshot. Images (PNG, JPEG, GIF, WebP, SVG) are attached like any other file. Each one is attached with a name, a storage location, and the phases that read it. `sflow documents upload <FILE> --name <NAME>` attaches a file and pins it by SHA-256; the Story's `documents.json` records its `DOC-nnn` ID, name, hash, size, storage, and phases. Names are required and unique within the Story: case and spacing are ignored, and a detached document keeps its name. Prompts list each document as `DOC-nnn — <name>`, and artifacts cite it the same way.

## Where a document is kept

- **Git** (`--store git`, for older Stories whose approved policy allows it, and only for files SFlow can read
  for secrets): the bytes are committed under `singularity/work-items/<WORK-ID>/inputs/DOC-nnn/` and pushed with the
  Story, so every clone, reviewer, and pipeline reads the same evidence.
- **This laptop only** (`--store local`, the default for new uploads): the bytes stay in this clone's Git directory
  (`singularity-flow-documents/<WORK-ID>/<sha256>/`, shared by its worktrees) and are never
  committed or pushed. Git records only the name, SHA-256, and size. Other clones list the document
  as unavailable, and a local copy whose bytes changed is reported as changed. When this phase needs
  a missing document, choose the same original on this laptop and run
  `singularity-flow documents restore <DOC-ID> --file <LOCAL-FILE> --work-id <WORK-ID>`.
  Restore verifies size and SHA-256, preserves the existing ID and approvals, changes no Git ref,
  and never creates a new Story. A changed local copy is archived before exact restoration.
  Extracted source text is delivered in private runtime context, not committed prompts or caches.
  A factory reset keeps these files
  and lists them; only `--include-local-documents` on both its preview and the reset deletes them.
- OneDrive, SharePoint, and Jira are not storage locations yet; choosing one is refused with
  `DOCUMENT_STORAGE_UNSUPPORTED`. They remain sources: `sflow documents fetch` copies a provider file
  into the Story and pins it like an upload. A Story started from a Jira issue can attach that issue's
  own attachments: `sflow documents fetch --provider jira --ref <attachment-id>` downloads one from the
  configured Jira, named after its file unless `--name` says otherwise, and `sflow documents list` shows
  the attachments not attached yet.
- A Story released from an Epic can import the Epic's sources:
  `sflow documents fetch --provider epic --ref <SRC-ID>` reads the source at the commit the Story was
  cut from, checks it against its record and the SHA-256 the Epic manifest pins, and copies it in as a
  document named as the Epic named it. A source that fails a check is refused and listed with the
  reason, and `sflow documents list` shows the ones not imported yet. Only a Story in the Epic's lead
  repository carries them; elsewhere, upload the files instead.

A repository can narrow the choice with `documents.storage: { allowed: [git], default: git }` in its
workflow configuration, for all work types or under `workTypes.<id>.documents`.

New starter configurations use `documents.storage: { allowed: [local], default: local }`. Older
Git-backed documents and explicit approved storage policies are not silently moved or deleted.
Folders can stay local too: their member identities are shared, never bytes or a broken Git gallery.
All linked Story worktrees of one clone share the same private store.

## Which phases read it

Each document names the phases that use it: `--phases specification,planning`, or `--phases all`.
Without `--phases`, a document serves the current phase and every later one. A phase outside the
list never sees it: its prompt leaves it out and its source review does not expect it to be cited.
`sflow documents list --phase <phase>` shows exactly what a phase receives: its supporting documents
only, without the Story's generated and workflow documents.

While a step awaits approval, a document offered only to other steps (`--phases <later-step>`) can be
uploaded or fetched without withdrawing the submission: its review never saw it, and approval checks
that commit as exactly that. A document offered to the step under review still withdraws it.

To change the list later, preview the change first:

```sh
sflow documents scope <DOC-ID|NAME> --phases <A,B> --reason TEXT --dry-run
```

Then run the same command with `--yes`. The change applies forward only: it decides what later
prompts include and never reopens a phase. The preview lists published work that already used the
document; that work keeps it. To withdraw a document from published work, detach it. Each change is
kept as a decision record under `evidence/document-scope/`.

## How the phases use documents

- **Intake.** VS Code Start Work and `sflow start` (`--document <FILE> --document-name <NAME>`,
  optionally `--document-phases <A,B>` and `--document-store git|local`, given once for every
  document or once per document) capture documents before anything is created, and record them in
  the Story's opening commit. Each document can be kept and scoped differently; given once, those
  options also apply to documents a story file lists unless an entry sets its own `store` or
  `phases`. A file the environment declaration keeps local is refused by its path in the checkout.
- **Prompts.** Every phase in a document's list receives it as pinned evidence. For local files,
  source text and verified file paths are added to a private runtime section and a Git-private
  context file; durable prompt snapshots contain only identity. Text is fenced and
  included, up to 48 KiB per prompt across all its documents (`documents.maxPromptEvidenceBytes`);
  past that, a document is shown in part or named with `sflow documents view`. Word (DOCX), Excel
  (XLSX) and PowerPoint (PPTX) files contribute their extracted text. A PDF or image kept in Git is listed with its repository path, and the phase is told to open it with its file, image, or
  PDF tool rather than guess from its name. A local binary gets its exact verified private path;
  missing originals trigger a re-upload request before composition or authoring. `wm compose --out`
  exports the complete runtime prompt and must target the Git-private
  `<git-dir>/singularity-flow/` directory when local attachments are present (a refused destination
  returns an exact suggested path). `phase enter --compose` also returns the exact private runtime
  context file for reading local evidence. Auto contracts pin local document IDs/hashes and
  materialize exact read-only file grants afresh before invocation, without granting access to the
  whole store or committing local paths. Instructions
  inside a document are untrusted evidence, never commands.
- **Specification.** `/sf-specify` composes its prompt once for its supporting documents, cites
  the documents it used in a `## Sources` section, and lists unreadable or unavailable ones as gaps.
- **Source review.** `/sf-review-source` checks the Specification and Plan against the documents
  offered to that phase. Present local text and Office files are read against exact original hashes.
  Images and PDFs arrive as `visualSources` with verified local paths. The reviewer must inspect
  each with a native image/PDF tool, record `visualSourcesReviewed` (method, page/region and concrete
  observations), and cite that location in a row `attestation`. Pixels never get invented text lines.
  If the host has no suitable tool, ask the human for inspection help or a text export; never claim
  the file was read. This is native visual inspection, not built-in OCR or PDF text extraction.
  Missing local originals trigger re-upload, not a waiver. Other unreadable documents, such as URLs
  without pinned bytes or unsupported binary formats, become an `unreadable:<DOC-id>`
  finding that a person prepares with
  `sflow review-source decision-context <phase> --work-id <WORK-ID> --finding unreadable:<DOC-id> --reason <TEXT> --json`.
  After reviewing that exact packet, the human confirms its returned `decide --confirm` command;
  in Copilot use `/sf-review-decide`, never the independent reviewer turn.

## Purpose and prerequisites

Use this topic to attach, name, store, scope, and cite the documents a Story is built from. Start in
the Story's Singularity Flow checkout and run `sflow status` to confirm the Work ID and current phase.
Uploads are accepted at Story start, in the first phase, and in the phases a work type lists under
`documents.allowedPhases` (Specification and Planning in the spec-driven starters). Epics attach
their sources with `sflow epic sources add` instead.

## Use it from each surface

- **Shell:** `sflow documents upload <FILE…> --name <NAME…> [--phases <A,B>|all] [--store git|local]`,
  `sflow documents list [--phase <phase>]`, `sflow documents view <DOC-ID|NAME>`,
  `sflow documents scope`, `sflow documents detach`, `sflow documents fetch`. Run
  `singularity-flow documents --help` for the exact forms supported by this build.
- **Takeover:** `singularity-flow documents readiness --phase <PHASE> --json` lists only this phase's
  missing originals. Restore each using `singularity-flow documents restore <DOC-ID> --file <LOCAL-FILE>`.
  In VS Code, opening a missing supporting document offers a picker for this same verified restore.
- **Copilot:** `/sf-upload`, `/sf-documents`, `/sf-start`, `/sf-specify`, `/sf-review-source`. The
  skills preserve the CLI result and ask before it changes anything.
- **VS Code:** attaching a file asks for its name, where to keep it (**Commit to Git** or **Keep on
  this machine only**), and its phases. The Evidence view shows each document's name, storage,
  availability, and phases; **Phases…** previews a scope change before applying it. Start Work asks,
  for each document or image, its name, where it is kept, and which phases use it.

## Guided workflow

1. Confirm the Story and phase with `sflow status`.
2. Attach: `sflow documents upload brief.md --name "Payment brief" --phases specification,planning`.
   Add `--store local` to keep the bytes on this machine.
3. Check what a phase will read with `sflow documents list --phase specification`.
4. Generate the phase with its skill (for example `/sf-specify`); the artifact cites
   `DOC-nnn — <name>`.
5. When the work type pins source review, run `/sf-review-source`; use `/sf-review-decide` in a
   separate human-decision turn for any pending `unreadable:` findings.
6. To change which phases use a document, preview `sflow documents scope` with `--dry-run`, then
   apply it with `--yes`. The change applies to later prompts only: work already published keeps
   the document, and the preview lists it. A prompt composed but not yet published is recomposed.

## State and safety

- Every upload is scanned for secrets before it is recorded, including the text extracted from
  Word and Excel files; a detected secret refuses the upload, wherever it would be kept.
- The repository never holds a secret, so a file SFlow cannot read stays out of Git. A PDF, an image, an archive
  or an older `.doc`, `.xls` or `.ppt` is refused with `--store git` (`DOCUMENT_UNREADABLE_IN_GIT`), and kept with
  `--store local`. To share one, save it as text or a Word document.
- Names are checked before anything is written: a missing, duplicate, or ID-shaped name is refused,
  and every file needs its own `--name`.
- Detaching (`sflow documents detach <DOC-ID|NAME> --reason TEXT --yes`) keeps the record and its
  name, and stops offering the document to prompts. A phase up to the current one whose published
  work used it (its prompt listed it, its artifact cites it under `## Sources`, or it was offered the
  document when it published) reopens, with every later phase; `--dry-run` previews exactly that.
  A cancelled or closed Story's documents no longer change.
- Another laptop must restore the same originals before a phase needing them can author, review or
  publish. Exact re-upload restores the source binding without invalidating prior approvals.
  Reviewed generations retain their verified source-readability contract after upgrades.
  Publication refuses if local-only source bytes are committed under `inputs/`.

## Troubleshooting

- `DOCUMENT_NAME_REQUIRED`: give one `--name` per file, or fill in each Start Work slot's name.
- `DOCUMENT_NAME_TAKEN`: choose another name; names are unique across active and detached documents.
- `DOCUMENT_LOCAL_UNAVAILABLE` / `DOCUMENT_REUPLOAD_REQUIRED`: choose the same original on this
  laptop and run `singularity-flow documents restore <DOC-ID> --file <LOCAL-FILE>`.
- `DOCUMENT_LOCAL_CHANGED`: this machine's copy no longer matches its recorded SHA-256. Re-attach
  the original, or detach it.
- `DOCUMENT_STORAGE_UNSUPPORTED` or `DOCUMENT_STORAGE_NOT_ALLOWED`: use a storage the repository
  allows (`--store git` or `--store local`), or `sflow documents fetch` to copy a provider file in.
- A phase does not mention a document: check `sflow documents list --phase <phase>` and widen its
  phases with `sflow documents scope`.

## Related topics

Continue with `sflow explain starting-work`, `sflow explain artifacts-and-generation`, `sflow explain specification-quality`, `sflow explain epics-and-planning`.
