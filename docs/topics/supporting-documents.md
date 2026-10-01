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
version: 3
---
Supporting documents are the evidence a Story is built from: a brief, API notes, a spreadsheet of rules, a design export or screenshot. Images (PNG, JPEG, GIF, WebP, SVG) are attached like any other file. Each one is attached with a name, a storage location, and the phases that read it. `sflow documents upload <FILE> --name <NAME>` attaches a file and pins it by SHA-256; the Story's `documents.json` records its `DOC-nnn` ID, name, hash, size, storage, and phases. Names are required and unique within the Story: case and spacing are ignored, and a detached document keeps its name. Prompts list each document as `DOC-nnn — <name>`, and artifacts cite it the same way.

## Where a document is kept

- **Git** (`--store git`, the default): the bytes are committed under
  `singularity/work-items/<WORK-ID>/inputs/DOC-nnn/` and pushed with the Story, so every clone,
  reviewer, and pipeline reads the same evidence.
- **This machine only** (`--store local`): the bytes stay in this clone's Git directory
  (`singularity-flow/local-documents/<WORK-ID>/<sha256>/`, shared by its worktrees) and are never
  committed or pushed. Git records only the name, SHA-256, and size. Other clones list the document
  as unavailable, and a local copy whose bytes changed is reported as changed. Re-attach it with
  `--store git` when it should be shared.
- OneDrive, SharePoint, and Jira are not storage locations yet; choosing one is refused with
  `DOCUMENT_STORAGE_UNSUPPORTED`. They remain sources: `sflow documents fetch` copies a provider file
  into the Story and pins it like an upload.

A repository can narrow the choice with `documents.storage: { allowed: [git], default: git }` in its
workflow configuration, for all work types or under `workTypes.<id>.documents`.

## Which phases read it

Each document names the phases that use it: `--phases specification,planning`, or `--phases all`.
Without `--phases`, a document serves the current phase and every later one. A phase outside the
list never sees it: its prompt leaves it out and its source review does not expect it to be cited.
`sflow documents list --phase <phase>` shows exactly what a phase receives.

To change the list later, preview the change first:

```sh
sflow documents scope <DOC-ID|NAME> --phases <A,B> --reason TEXT --dry-run
```

Then run the same command with `--yes`. The preview names every phase whose prompt already used the
document. Removing one of those marks only that phase's prompt records stale and
reopens the earliest affected phase; adding a phase reopens nothing and takes effect at its next
prompt. Each change is kept as a decision record under `evidence/document-scope/`.

## How the phases use documents

- **Intake.** VS Code Start Work and `sflow start` (`--document <FILE> --document-name <NAME>`,
  optionally `--document-phases <A,B>` and `--document-store git|local`, given once for every
  document or once per document) capture documents before anything is created, and record them in
  the Story's opening commit. Each document can be kept and scoped differently.
- **Prompts.** Every phase in a document's list receives it as pinned evidence. Text up to 1 MiB is
  included; Word (DOCX) and Excel (XLSX) files contribute their extracted text. A PDF or image kept in
  Git is listed with its repository path, and the phase is told to open it with its file, image, or
  PDF tool rather than guess from its name; one kept on this machine is read with
  `sflow documents view`, and one kept on another machine contributes metadata only. Instructions
  inside a document are untrusted evidence, never commands.
- **Specification.** `/sf-specify` reads `sflow documents list --phase specification --json`, cites
  the documents it used in a `## Sources` section, and lists unreadable or unavailable ones as gaps.
- **Source review.** `/sf-review-source` checks the Specification and Plan against the documents
  offered to that phase. A document the reviewer cannot read (a URL, PDF, image, oversized file, or
  one kept on another machine) does not block the review: it becomes an `unreadable:<DOC-id>`
  finding that a person decides with
  `sflow review-source decide <phase> --finding unreadable:<DOC-id> --reason TEXT`.

## Purpose and prerequisites

Use this topic to attach, name, store, scope, and cite the documents a Story is built from. Start in
the Story's governed checkout and run `sflow status` to confirm the Work ID and current phase.
Uploads are accepted at Story start, in the first phase, and in the phases a work type lists under
`documents.allowedPhases` (Specification and Planning in the spec-driven starters). Epics attach
their sources with `sflow epic sources add` instead.

## Use it from each surface

- **Shell:** `sflow documents upload <FILE…> --name <NAME…> [--phases <A,B>|all] [--store git|local]`,
  `sflow documents list [--phase <phase>]`, `sflow documents view <DOC-ID|NAME>`,
  `sflow documents scope`, `sflow documents detach`, `sflow documents fetch`. Run
  `singularity-flow documents --help` for the exact forms supported by this build.
- **Copilot:** `/sf-upload`, `/sf-documents`, `/sf-start`, `/sf-specify`, `/sf-review-source`. The
  skills preserve the CLI result and ask before any governed mutation.
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
5. When the work type pins source review, run `/sf-review-source` and decide any `unreadable:`
   findings.
6. To change which phases use a document, preview `sflow documents scope` with `--dry-run`, then
   apply it with `--yes`. The change applies to later prompts only: work already published keeps
   the document, and the preview lists it. A prompt composed but not yet published is recomposed.

## State and safety

- Every upload is scanned for secrets before it is recorded, including the text extracted from
  Word and Excel files; a detected secret refuses the upload.
- Names are checked before anything is written: a missing, duplicate, or ID-shaped name is refused,
  and every file needs its own `--name`.
- Detaching (`sflow documents detach <DOC-ID|NAME> --reason TEXT --yes`) keeps the record and its
  name, and stops offering the document to prompts. A phase up to the current one whose published
  work used it (its prompt listed it, its artifact cites it under `## Sources`, or it was offered the
  document when it published) reopens, with every later phase; `--dry-run` previews exactly that.
  A cancelled or completed Story's documents no longer change.
- Nobody else can verify a document kept on this machine. Reviews record it as an unreadable
  finding, and publication refuses if its bytes are ever committed under `inputs/`.

## Troubleshooting

- `DOCUMENT_NAME_REQUIRED`: give one `--name` per file, or fill in each Start Work slot's name.
- `DOCUMENT_NAME_TAKEN`: choose another name; names are unique across active and detached documents.
- `DOCUMENT_LOCAL_UNAVAILABLE`: the document was kept on another machine. Ask whoever added it to
  re-attach it with `--store git`, or decide the review's `unreadable:` finding.
- `DOCUMENT_LOCAL_CHANGED`: this machine's copy no longer matches its recorded SHA-256. Re-attach
  the original, or detach it.
- `DOCUMENT_STORAGE_UNSUPPORTED` or `DOCUMENT_STORAGE_NOT_ALLOWED`: use a storage the repository
  allows (`--store git` or `--store local`), or `sflow documents fetch` to copy a provider file in.
- A phase does not mention a document: check `sflow documents list --phase <phase>` and widen its
  phases with `sflow documents scope`.

## Related topics

Continue with `sflow explain starting-work`, `sflow explain artifacts-and-generation`, `sflow explain specification-quality`, `sflow explain epics-and-planning`.
