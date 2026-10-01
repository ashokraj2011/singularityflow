---
name: sflow-upload
description: Attach, inspect, list, or governably detach files, folders, images, PDFs, Figma exports, notes, and HTTPS references for an Epic or Story.
disable-model-invocation: true
argument-hint: "attach <PATH...> [--epic EPIC-ID] | list [OWNER-ID] | view <ID|NAME> [--work-id WORK-ID] | detach <ID|NAME> --reason TEXT [--epic EPIC-ID]"

---

# Upload governed evidence

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents.

REV feedback: use `/sf-revision-attachments`; ordinary upload cannot bypass its importer.

1. Use explicit `--epic` for an Epic. Story attach/detach has no `--work-id`: identify the attached Story with `singularity-flow session current --json`, or ask the user to attach it first. Never append an unsupported selector.
2. Resolve the action; show owner and target before mutation.
3. For an Epic:
   - Use `singularity-flow epic sources add --epic <EPIC-KEY> --file <PATH>` once per file; expand directories in deterministic order.
   - Record authored text with `singularity-flow epic sources note --epic <EPIC-KEY> --text-file <PATH>`.
   - Record an HTTPS reference with `singularity-flow epic sources add --epic <EPIC-KEY> --url <URL> --label "<LABEL>"`.
   - Add `--provider`, `--mime`, or `--label` only when provided or required by repository policy.
4. For the verified attached Story, ask the user for a unique name per path or URL:
   - Upload files or complete export directories with `singularity-flow documents upload <PATH...> --name "<NAME>"` (one `--name` per path, in order), plus `--phases <PHASE,...|all>` only if the user limits its phases, and `--store local` when they want files kept on this machine only.
   - Record an HTTPS reference with `singularity-flow documents upload --url <URL> --name "<NAME>"`.
5. Respect phase, provider, size, and sequence gates; leave soft warnings to the user.
6. Never expose credentials, follow a URL implicitly, invent a MIME type, or bypass the managed catalog.
7. Report each stable source/document ID, SHA-256, size, path/provider, commit, push result, and next `/sf-*` command.

For detachment:

1. List active evidence and show the exact ID, name, hash, path/URL, package, and affected phases from `singularity-flow documents detach <ID> --dry-run`.
2. If it belongs to a package, ask whether to detach this file or the complete package; never choose automatically.
3. Require a reason and explain: committed bytes remain for audit and future Copilot prompts omit the evidence.
4. Require explicit human confirmation. Do not self-confirm.
5. Only after confirmation, for a Story run `singularity-flow documents detach <DOCUMENT-ID> --reason "<reason>" --yes`, adding `--scope package` only when selected.
6. Only after confirmation, for an Epic run `singularity-flow epic sources detach <SOURCE-ID> --epic <EPIC-ID> --reason "<reason>" --yes`. `--yes` conveys the reviewed decision to the noninteractive CLI; never add it before confirmation.
7. Report the CLI decision, commit, publication status, invalidated and reopened phases, and next `/sf-*` action.

Use `--all` listings only to inspect detached history. Never delete or directly alter governed evidence bytes.
