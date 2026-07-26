---
name: sflow-upload
description: Upload local files, folders, images, PDFs, Figma exports, notes, and HTTPS references as governed Epic or Story evidence.
argument-hint: "<PATH...> [--epic EPIC-KEY | --work-id WORK-ID] [--url URL] [--label TEXT]"
disable-model-invocation: true
---

# Upload governed evidence

Use this skill whenever a user wants to add files or links to the active Epic or Story. Do not copy files directly into `singularity/`.

1. Read the explicit `--epic` or `--work-id` target. If neither is supplied, inspect the current Singularity Flow session and branch. Continue automatically when exactly one active Epic or Story is unambiguous; otherwise ask which target should own the evidence.
2. Show the resolved target, source path or URL, and intended evidence type before writing.
3. For an Epic:
   - Upload a file with `singularity-flow epic sources add --epic <EPIC-KEY> --file <PATH>`.
   - Upload multiple paths by running the command once per path. Expand directories in deterministic path order.
   - Record authored text with `singularity-flow epic sources note --epic <EPIC-KEY> --text-file <PATH>`.
   - Record an HTTPS reference with `singularity-flow epic sources add --epic <EPIC-KEY> --url <URL> --label "<LABEL>"`.
   - Add `--provider`, `--mime`, or `--label` only when provided or required by repository policy.
4. For a Story:
   - Upload files or complete export directories with `singularity-flow documents upload <PATH...>`.
   - Record an HTTPS reference with `singularity-flow documents upload --url <URL> --label "<LABEL>"`.
5. Respect configured phases, providers, file-size limits, and sequence gates. On a hard gate, stop and show the exact recovery command. On a soft warning, show it and let the user decide whether to continue.
6. Never expose credentials, follow a URL implicitly, invent a MIME type when detection is available, or bypass the managed catalog.
7. After success, print every stable source/document ID, SHA-256, size, provider or repository path, commit, and push result. Finish with the next applicable `/sflow-*` command.

Use `/sflow-epic-sources` for detailed Epic-source verification and `/sflow-documents` for listing or viewing Story evidence.
