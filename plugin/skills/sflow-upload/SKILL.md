---
name: sflow-upload
description: Attach, inspect, list, or governably detach local files, folders, images, PDFs, Figma exports, notes, and HTTPS references owned by an Epic or Story.
disable-model-invocation: true
argument-hint: "attach <PATH...> | list | view <ID> | detach <ID> [--scope package] --reason TEXT [--epic EPIC-ID | --work-id WORK-ID]"

---

# Upload governed evidence

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** Flow-reported root only (Story: `singularity/work-items/<WORK-ID>/`). Deterministic: `--no-model`; kernel model: forbidden.

Use this skill whenever a user wants to attach, inspect, list, view, or detach evidence from the active Epic or Story. Do not copy files directly into `singularity/`.

1. Use explicit `--epic` or `--work-id`; otherwise inspect session/branch. Continue when exactly one target is unambiguous, or ask which owns the evidence.
2. Determine the requested operation: attach, list, view, or detach. Show the resolved owner and exact evidence target before any mutation.
3. For an Epic:
   - Upload a file with `singularity-flow epic sources add --epic <EPIC-KEY> --file <PATH>`.
   - Run once per path; expand directories in deterministic path order.
   - Record authored text with `singularity-flow epic sources note --epic <EPIC-KEY> --text-file <PATH>`.
   - Record an HTTPS reference with `singularity-flow epic sources add --epic <EPIC-KEY> --url <URL> --label "<LABEL>"`.
   - Add `--provider`, `--mime`, or `--label` only when provided or required by repository policy.
4. For a Story:
   - Upload files or complete export directories with `singularity-flow documents upload <PATH...>`.
   - Record an HTTPS reference with `singularity-flow documents upload --url <URL> --label "<LABEL>"`.
5. Respect phase, provider, size, and sequence policy. Stop on hard gates; let the user decide on soft warnings.
6. Never expose credentials, follow a URL implicitly, invent a MIME type when detection is available, or bypass the managed catalog.
7. After success, print every stable source/document ID, SHA-256, size, provider or repository path, commit, and push result. Finish with the next applicable `/sf-*` command.

For detachment:

1. List active evidence and show the exact ID, label, hash, path/URL, package, and affected phases.
2. If it belongs to a Figma or other package, ask whether to detach this file or the complete package. Never choose package scope automatically.
3. Require a reason and explain the consequences: committed bytes remain for audit, future Copilot prompts omit the evidence, and only its dependency cone is invalidated.
4. Require explicit human confirmation. Do not self-confirm.
5. For a Story run `singularity-flow documents detach <DOCUMENT-ID> --reason "<reason>"`, adding `--scope package` only when selected.
6. For an Epic run `singularity-flow epic sources detach <SOURCE-ID> --epic <EPIC-ID> --reason "<reason>"`.
7. Report the CLI decision, commit, publication status, invalidated/reopened phases, and next `/sf-*` action.

Use `documents list --all` or `epic sources list --epic <EPIC-ID> --all` only to inspect detached history. Never delete or directly alter governed evidence bytes.

Use `/sf-epic-sources` for detailed Epic-source verification and `/sf-documents` for listing or viewing Story evidence.
