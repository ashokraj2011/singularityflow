---
name: sflow-documents
description: Upload, list, and view Singularity Flow supporting documents, images, Figma files, and external design links during configured intake phases.
argument-hint: "list [WORK-ID] | view <DOCUMENT-ID> | upload <PATH...> [--url URL] [--label TEXT]"
disable-model-invocation: true
---
# Manage supporting documents

Sequence gates may be hard or soft. On `Out of sequence`, stop immediately and relay the error. On `Soft sequence warning`, show the full warning and leave the interactive `continue` decision to the human; never self-confirm. Listing and viewing remain read-only; never bypass the upload gate by copying files into managed work-item folders.

Use the deterministic document catalog; never copy inputs into arbitrary repository locations.

- In an experimental Copilot CLI session, the bare `/documents` extension command opens the searchable Documents canvas; `/documents view <DOCUMENT-ID>` opens a specific item. If canvas rendering is unavailable, it falls back to timeline output.
- List all uploaded inputs, generated phase documents, status, and source context with `singularity-flow documents list [WORK-ID]`.
- View text documents with `singularity-flow documents view <DOCUMENT-ID>`. For images, PDFs, `.fig`, and other binary formats, use the returned absolute path with the appropriate viewer.
- Upload user-provided local files or complete export directories with `singularity-flow documents upload <PATH...>`. Directories are expanded recursively in deterministic path order, their relative structure is preserved, and every file is copied, hashed, attributed, committed, and pushed under the work item.
- Record a Figma or other external reference with `singularity-flow documents upload --url <https-url> --label "<name>"`.
- Respect the configured upload phases and maximum size. Never bypass those policies or download an external URL implicitly.
- After upload, report document IDs and use those stable IDs in intake, requirements, design, specification, and conformance artifacts.
