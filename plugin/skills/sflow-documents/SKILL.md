---
name: sflow-documents
description: Attach, list, view, and governably detach Singularity Flow supporting documents, images, Figma packages, and external design links while preserving audit history.
disable-model-invocation: true
argument-hint: "list [WORK-ID] [--active|--all] | view <DOCUMENT-ID> | upload <PATH...> | detach <DOCUMENT-ID> [--scope package] --reason TEXT"

---
# Manage supporting documents

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** `singularity-flow workspace current --json` → cwd=`repositoryPath`; never `$HOME`. Story: `singularity/work-items/<WORK-ID>/`.

On `Out of sequence`, stop and relay the error. On `Soft sequence warning`, show it and leave `continue` to the human. Listing and viewing are read-only; never bypass upload gates.

Use the deterministic document catalog; never copy inputs into arbitrary repository locations.

For a short upload-first experience, use `/sf-upload`. This skill remains the complete attach, list, view, preview, and detach interface.

- List active uploaded inputs and generated phase documents with `singularity-flow documents list [WORK-ID] --active`. Use `--all` only when the user asks for detached history.
- For an Epic, list active sources with `singularity-flow epic sources list --epic <EPIC-ID> --active`; use `--all` only for detached history.
- View text documents with `singularity-flow documents view <DOCUMENT-ID>`. For images, PDFs, `.fig`, and other binary formats, use the returned absolute path with the appropriate viewer.
- Upload files or export directories with `singularity-flow documents upload <PATH...>`. Directories retain deterministic relative paths; files are copied, hashed, attributed, committed, and pushed.
- Record a Figma or other external reference with `singularity-flow documents upload --url <https-url> --label "<name>"`.
- Respect the configured upload phases and maximum size. Never bypass those policies or download an external URL implicitly.
- After upload, report document IDs and use those stable IDs in intake, requirements, design, specification, and conformance artifacts.

To detach evidence:

1. Show the active document's ID, label, path/URL, SHA-256, package, and dependencies.
2. For a Figma or other package member, ask whether to detach only that file or the complete package. Never infer package scope.
3. Require a non-empty reason. Explain that bytes and audit history remain committed, future prompts omit the evidence, and dependent generated work or approvals may be invalidated.
4. Require explicit human confirmation. Do not self-confirm. Then run `singularity-flow documents detach <DOCUMENT-ID> --reason "<reason>"`; add `--scope package` only when the user chose the complete package.
   For an Epic source run `singularity-flow epic sources detach <SOURCE-ID> --epic <EPIC-ID> --reason "<reason>"` after the same preview and confirmation.
5. Report the decision record, commit, push or pending-publication status, invalidated phases, reopened phase, and exact next valid `/sf-*` action from the CLI result.

Detached evidence is read-only. Never delete its bytes or manually edit its manifest status.
