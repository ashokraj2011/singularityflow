---
name: sflow-documents
description: Attach, list, view, and governably detach Singularity Flow supporting documents, images, Figma packages, and external design links while preserving audit history.
disable-model-invocation: true
argument-hint: "list [WORK-ID] | view <DOCUMENT-ID> [--work-id ID] | upload <PATH...> | detach <DOCUMENT-ID> --reason TEXT | epic sources ... --epic EPIC-ID"

---
# Manage supporting documents

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

Stop on `Out of sequence`; show soft warnings for human choice. Use the catalog, not arbitrary copies. Explicit Work ID supports Story reads. Story upload/detach has no `--work-id`, so attach that Story first; never target an ambient branch. Epic sources require `--epic`, not a Story session. `/sf-upload` is the short upload route.

- List active uploaded inputs and generated phase documents with `singularity-flow documents list [WORK-ID] --active`. Use `--all` only when the user asks for detached history.
- For an Epic, list active sources with `singularity-flow epic sources list --epic <EPIC-ID> --active`; use `--all` only for detached history.
- View text with `singularity-flow documents view <DOCUMENT-ID> --work-id <WORK-ID>`, or omit the selector for the attached Story. Open binary formats from the returned absolute path.
- For the verified attached Story, use `singularity-flow documents upload <PATH...>`; directories retain relative paths and files are hashed, attributed, committed, and pushed.
- Record a Figma or other external reference with `singularity-flow documents upload --url <https-url> --label "<name>"`.
- Respect phase/size policy; never download URLs implicitly. Report and cite stable document IDs.

To detach evidence:

1. Show ID, label, path/URL, SHA-256, package, and dependencies.
2. Ask whether to detach one package member or the package; never infer scope.
3. Require a reason. Explain that committed bytes remain, future prompts omit them, and dependants may be invalidated.
4. Require explicit human confirmation. Do not self-confirm. Only after it, run `singularity-flow documents detach <DOCUMENT-ID> --reason "<reason>" --yes`; add `--scope package` only when the user chose the complete package.
   For an Epic source run `singularity-flow epic sources detach <SOURCE-ID> --epic <EPIC-ID> --reason "<reason>" --yes` after the same preview and confirmation. `--yes` conveys that reviewed decision to the noninteractive CLI; it is never consent by itself.
5. Report the decision, commit/publication, invalidated phases and reopened phase, and returned `/sf-*` action.

Detached evidence is read-only. Never delete its bytes or manually edit its manifest status.
