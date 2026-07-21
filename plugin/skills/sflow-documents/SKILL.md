---
name: sflow-documents
description: Upload, list, and view Singularity Flow supporting documents, images, Figma files, and external design links during configured intake phases.
argument-hint: "list [WORK-ID] | view <DOCUMENT-ID> | upload <PATH...> [--url URL] [--label TEXT]"
disable-model-invocation: true
---
# Manage supporting documents

Use the deterministic document catalog; never copy inputs into arbitrary repository locations.

- List all uploaded inputs, generated phase documents, status, and source context with `singularity-flow documents list [WORK-ID]`.
- View text documents with `singularity-flow documents view <DOCUMENT-ID>`. For images, PDFs, `.fig`, and other binary formats, use the returned absolute path with the appropriate viewer.
- Upload user-provided local or attached files with `singularity-flow documents upload <PATH...>`. The CLI copies, hashes, records actor/persona, commits, and pushes them under the work item.
- Record a Figma or other external reference with `singularity-flow documents upload --url <https-url> --label "<name>"`.
- Respect the configured upload phases and maximum size. Never bypass those policies or download an external URL implicitly.
- After upload, report document IDs and use those stable IDs in intake, requirements, design, specification, and conformance artifacts.
