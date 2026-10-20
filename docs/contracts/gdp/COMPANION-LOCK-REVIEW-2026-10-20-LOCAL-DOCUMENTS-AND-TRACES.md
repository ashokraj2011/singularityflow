# GDP companion authority review — laptop-local Story documents and performance traces — 2026-10-20

Review boundary: `4b8dca9588be431e01fbf0d0bd0800c871337c8f` (`main` at this review). The preceding review is `COMPANION-LOCK-REVIEW-2026-10-19-PUBLICATION-CONTEXT.md`.

Two GDP-locked companions changed without a review, so the lock failed on `main`:

- `workflow-configuration`, in `ab2155a0` ("Keep Story uploads laptop-local and restore pinned documents on takeover");
- `migration-registry`, in `cccf1f04` ("Add opt-in classified performance traces").

This review covers both changes after the fact. It is not a bulk hash refresh, and it adds no approval authority. Every other companion still matches its accepted digest.

## Reviewed in `templates/workflow.yml` (`workflow-configuration`)

The change is one added line under `documents`:

```yaml
documents:
  storage: { allowed: [local], default: local }
```

- **What it does:**
  - A configuration made from the starter template stores new Story uploads only on the laptop that uploaded them.
  - The bytes go to `<git-common-dir>/singularity-flow-documents/<Work-ID>/<sha256>/<filename>`, shared by that clone's worktrees.
  - Git records each document's identity, name, SHA-256, size and phase scope, never its bytes (docs/local-document-handoff.md).
- **What validates it:**
  - `assertDocumentStoragePolicy` (src/config.mjs) checks the policy when the configuration is loaded.
  - `documentStorageChoices` (src/document-storage-policy.mjs) offers only `local`.
  - A request for `git` storage is refused with `DOCUMENT_STORAGE_NOT_ALLOWED`, naming the allowed kinds.
- **Only the starter configuration changes:**
  - An existing repository's approved `workflow.yml` is never rewritten.
  - A configuration with no `documents.storage` key gets local as its default, through the code change in the same commit, and still allows both kinds.
  - A repository whose approved policy lists `git` keeps it.
  - No Story's pinned policy changes.
- **Integrity is unchanged:**
  - Every document is still bound by its SHA-256 and size.
  - A missing or changed original on another laptop is reported with its ID, name, expected hash and an exact restore route (`documents restore … --file …`). Restore verifies the hash and size, and refuses a different file.
  - A source that really changed still needs a governed source update.
- **Approval is unchanged:**
  - Phase entry, next steps, preparation, source review and prepublication check the local documents offered to a phase before work proceeds.
  - Reviewers and approvers are the same groups.
  - Nothing here records, skips or weakens an approval.
- **The trade-off this accepts, stated plainly:** the original bytes of a Story's uploads are no longer retained in Git for configurations made from this template.
  - An auditor reading the repository later sees each document's identity and hash, not its content, unless someone keeps the original.
  - That is the purpose of the change: uploads can hold data that should not be copied into every clone.
  - Teams that need the bytes retained in Git set `documents.storage: { allowed: [git, local], default: git }` (or `git` only) through the normal reviewed configuration proposal.

## Reviewed in `src/schema-migrations.mjs` (`migration-registry`)

The change is two added lines: one new family.

```js
family({ id: 'performance-trace', currentVersion: 1,
  paths: [/^\$git\/dx\/performance\/[a-f0-9-]{36}(?:\.host)?\.json$/] }),
```

- **What it registers:** a machine-local, version-1 family with no migration step.
  - It covers the opt-in performance traces that `src/performance-trace-store.mjs` writes to `<git-dir>/singularity-flow/dx/performance/<invocation-id>.json`, plus the VS Code host's `<parent-span-id>.host.json` beside them.
  - The files are written only when `SINGULARITY_FLOW_PERF_TRACE=1` or the VS Code setting `singularityFlow.performanceTrace` is on.
  - They live inside the clone's Git directory, are never committed, and are pruned (64 records and 7 days by default).
- **Path ownership:** no other family claims these paths. The neighbouring `dx-command-timing` family owns `$git/dx/timings*.jsonl` and `$git/performance/commands.jsonl`, which this pattern cannot match. This review checked it with `familyForStoredPath`.
- **What registration does:** it fixes the schema version, so `readRecord` reads a version-1 trace and refuses a newer one (`SCHEMA_VERSION_FUTURE`). The store projects every field it keeps and never relays unknown attributes, prompts, URLs or file paths. The golden catalog lists version 1.
- **What it grants:** nothing. A trace is a diagnostic: no gate, approval or publication reads it.
- **Everything else is unchanged.** No other family changes its version, steps, paths or immutability.

Who approves anything is unchanged.

## Accepted digests

| Companion | Reviewed change | Previously accepted | Accepted at this review |
| --- | --- | --- | --- |
| `migration-registry` | The `performance-trace` version-1 family. | `sha256:b010402f5395514566ae22e7a1d2cc9793588c51f19b305e671ea010e113fcfc` | `sha256:788df5337b1fe8bdae3a156ccb2de80ee4acdf14df08906d337688cb61ec2770` |
| `workflow-configuration` | `documents.storage: { allowed: [local], default: local }` in the starter configuration. | `sha256:2c1629170aea3e0ae5511cfd021899b35eb7120d2d61d1ca600605afda761b4a` | `sha256:5e28785c9d8b2f52712f4fc15c3688ddc210afe4fecd7367e3843dfea4ebfc8d` |
