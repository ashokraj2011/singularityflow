---
name: sflow-documents
description: Attach, list, view, and governably detach Singularity Flow supporting documents, images, Figma packages, and external design links while preserving audit history.
disable-model-invocation: true
argument-hint: "list [WORK-ID] [--phase PHASE] | view <ID|NAME> [--work-id ID] | upload <PATH...> --name TEXT... | scope <ID|NAME> --phases PHASE,... | detach <ID|NAME> --reason TEXT | epic sources ... --epic EPIC-ID"

---
# Manage supporting documents

<!-- sflow-copilot-pause -->
Before any boundary lookup or SFlow action, run `singularity-flow pause status --json` and follow its `data.agentInstruction`. If `data.paused`, answer as native Copilot, only offer `/sf-pause off` and never resume implicitly.

<!-- sflow-output-contract: deterministic-mutation -->
**Output contract:** Let the CLI validate and mutate state; preserve its exact result, warnings, publication status, artifacts, and next actions. Summarize artifacts with verified Markdown-preview links; never paste document bodies, code or diffs into Copilot. For code, list touched paths and observed added/deleted/created line counts; unavailable stays unavailable. Use existing evidence, not extra calls solely for display. Summaries, links and opened previews are not human review or approval. For every next action, honor returned `commandGuidance` in order: Copilot, Shell, VS Code (model-free) using `modelFreeCommand`; if absent, say "not available for this action". Missing Copilot: "no verified equivalent". Never invent routes.
<!-- sflow-execution-boundary -->
**Boundary:** no Story required; cwd=opened Git root or verified `repositoryPath` from `singularity-flow workspace current --json`; refuse if neither resolves; never search `$HOME`/parents. Use exact CLI-returned paths. `repositoryPath` is command cwd, not a prefix for absolute file paths. Never rebase paths or strip `.git/worktrees`. Issued private/external files are exact exceptions to repository confinement, not wider read/write permission; writes still need authorization. Resolve relative paths only against their declared base. On failure, preserve the path and error; never search or recreate it.

Stop on `Out of sequence`; humans decide soft warnings. Story reads accept Work ID; upload/detach has no `--work-id`: verify `singularity-flow session current --json` or request attachment. Epic requires `--epic`. `/sf-upload` delegates here; never route back. REV feedback uses `/sf-revision-attachments`.

- List: `singularity-flow documents list [WORK-ID] --active [--phase <PHASE>]` or `singularity-flow epic sources list --epic <EPIC-ID> --active`. Use `--all` only for requested detached history.
- View: `singularity-flow documents view <DOCUMENT-ID|NAME> --work-id <WORK-ID>`; omit selector for attached Story. Open binaries at returned absolute paths.
- Missing here: ask for the original, then `singularity-flow documents restore <ID> --file "<chosen-path>" --work-id <WORK-ID> --json`. Preserve ID/hash/answers. `singularity-flow documents readiness --phase <PHASE> --json` lists required originals.
- Upload: `singularity-flow documents upload <PATH...> --name "<NAME>"`; one unique name per path. New workflows keep files/images here, sharing metadata only. Add `--phases <PHASE,...|all>` for requested limits. Preserve older explicit storage policy.
- Record a Figma or other external reference with `singularity-flow documents upload --url <https-url> --name "<name>"`.
- Scope: preview `singularity-flow documents scope <ID|NAME> --phases <PHASE,...|all> --reason "<reason>" --dry-run`; show retained published work. After explicit confirmation rerun without `--dry-run` with `--yes`.
- Epic: `singularity-flow epic sources add --epic <EPIC-ID> --file <PATH>` per file; text: `singularity-flow epic sources note --epic <EPIC-ID> --text-file <PATH>`; HTTPS: `singularity-flow epic sources add --epic <EPIC-ID> --url <URL> --label "<LABEL>"`.
- Respect phase/provider/size policy; never fetch URLs implicitly or expose credentials. Report IDs, hashes, size, path, commit/push and next.

To detach evidence:

1. Show ID, label, path/URL, SHA-256, package, and what `singularity-flow documents detach <ID> --dry-run` reopens.
2. Ask whether to detach one package member or the package; never infer scope.
3. Require a reason. Explain that committed bytes remain and future prompts omit them.
4. Require explicit human confirmation. Only after it, run `singularity-flow documents detach <DOCUMENT-ID> --reason "<reason>" --yes`; add `--scope package` only for the selected complete package. Epic: `singularity-flow epic sources detach <SOURCE-ID> --epic <EPIC-ID> --reason "<reason>" --yes` after the same preview/confirmation. `--yes` conveys consent; it never grants it.
5. Report the decision, commit/publication, invalidated phases, and returned `/sf-*` action.

Detached evidence is read-only; preserve bytes and manifest status.
