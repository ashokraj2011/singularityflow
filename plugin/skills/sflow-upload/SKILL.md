---
name: sflow-upload
description: Attach, inspect, list, or governably detach local files, folders, images, PDFs, Figma exports, notes, and HTTPS references owned by an Epic or Story.
disable-model-invocation: true
argument-hint: "attach <PATH...> [--epic EPIC-ID] | list [OWNER-ID] | view <ID> [--work-id WORK-ID] | detach <ID> --reason TEXT [--epic EPIC-ID]"

---

# Upload governed evidence

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

1. Use explicit `--epic` for an Epic. Story reads may use their documented Work-ID form. Story attach and detach do not support `--work-id`: require `singularity-flow session current --json` to identify the exact attached Story, or ask the user to attach it first. Never append an unsupported selector.
2. Resolve attach, list, view, or detach; show owner and target before mutation.
3. For an Epic:
   - Upload a file with `singularity-flow epic sources add --epic <EPIC-KEY> --file <PATH>`.
   - Run once per path; expand directories in deterministic path order.
   - Record authored text with `singularity-flow epic sources note --epic <EPIC-KEY> --text-file <PATH>`.
   - Record an HTTPS reference with `singularity-flow epic sources add --epic <EPIC-KEY> --url <URL> --label "<LABEL>"`.
   - Add `--provider`, `--mime`, or `--label` only when provided or required by repository policy.
4. For the verified attached Story:
   - Upload files or complete export directories with `singularity-flow documents upload <PATH...>`.
   - Record an HTTPS reference with `singularity-flow documents upload --url <URL> --label "<LABEL>"`.
5. Respect phase, provider, size, and sequence policy. Stop on hard gates; let the user decide on soft warnings.
6. Never expose credentials, follow a URL implicitly, invent a MIME type when detection is available, or bypass the managed catalog.
7. Print every stable source/document ID, SHA-256, size, path/provider, commit, and push result plus next `/sf-*` command.

For detachment:

1. List active evidence and show the exact ID, label, hash, path/URL, package, and affected phases.
2. If it belongs to a Figma or other package, ask whether to detach this file or the complete package. Never choose package scope automatically.
3. Require a reason and explain the consequences: committed bytes remain for audit, future Copilot prompts omit the evidence, and only its dependency cone is invalidated.
4. Require explicit human confirmation. Do not self-confirm.
5. Only after confirmation, for a Story run `singularity-flow documents detach <DOCUMENT-ID> --reason "<reason>" --yes`, adding `--scope package` only when selected.
6. Only after confirmation, for an Epic run `singularity-flow epic sources detach <SOURCE-ID> --epic <EPIC-ID> --reason "<reason>" --yes`. `--yes` conveys the reviewed decision to the noninteractive CLI; never add it before confirmation.
7. Report the CLI decision, commit, publication status, invalidated phases and reopened phase, and next `/sf-*` action.

Use `singularity-flow documents list --all` or `singularity-flow epic sources list --epic <EPIC-ID> --all` only to inspect detached history. Never delete or directly alter governed evidence bytes.
