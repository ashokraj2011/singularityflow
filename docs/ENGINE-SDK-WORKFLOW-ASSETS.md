# Portable workflow asset inventory

`workflow.assets` is a registered read operation. Its explicit `workflowIds` selection names Story
or Initiative workflows, including custom workflows. A native compatibility port calls the same
bundle compiler used for export, conversion and Story closure projection. The compiler retains
dependency discovery, missing/extra-asset checks, package and source validation, and hashing.
This extraction does not introduce a second closure algorithm or bypass its errors.

The kernel owns the dependency-name and count projections. They preserve the original export
field order and sorting, including skill-package phase order. Their moved bodies have the same
predecessor tokens. Native export's JSON, bundle bytes, digest, no-overwrite output handling and
human-readable contents/notes stay with the host. Its reader now enters the registry and retains
the captured compiler result privately, so it neither compiles again nor sends full bodies through
the SDK. Import and activation remain separate operations.

The result's `sflow-workflow-assets/v1` manifest includes the bundle digest, dependency IDs, counts,
skill-package hashes/phase bindings and captured configuration provenance. It excludes agent,
skill, instruction, template and constitution bodies, local mount paths and model/command prose.
It explicitly records no import, publication, human review or approval. A successful inventory is
not an import plan, an authorization grant or evidence that another host has installed the assets.

The ordinary `createSflow({root}).run('workflow.assets', {workflowIds})` API uses the narrow query
composition and a fresh approved-configuration read. A prior advisory configuration scope cannot
redirect it to an unapproved working copy. Direct legacy export still uses the configuration scope
its host selected, including an explicitly staged local configuration tree without Git. Only a
recognized approved ref/mirror identity is labelled `approved-snapshot`; other captured roots
remain `working-configuration`, with no claimed approved revision. No source history or branch
enumeration, extra remote refresh, provider invocation or lifecycle write is added.

The SDK rejects a differently selected workflow, a changed bundle digest, malformed dependency
lists, conflicting counts and undeclared body fields. Requests are detached before the first
await. Native missing-selection/dependency errors, timeouts and causes remain explicit, with no
automatic retry. Cancellation stops subsequent reads and never claims to undo an accepted effect.

Mac qualification on managed Node 26.12.0 passes 103 broader checks across eight files, with no
failures, cancellations or skips. It covers all packaged Story closures, a complete closure-only
Story, multi-workflow/cyclic/MCP dependency export, Story/Initiative namespaces, constitution and
instruction dependencies, source aliases, no-overwrite output and hook-refused import recovery.
The final 15-check run also passes actual source-CLI registry capture, forced installed-bundle
execution and six exact skill-package/binary/authority cases. CLI/SDK inventories agree and their
exported bytes match the existing compiler. The external SDK tarball and architecture guards pass.
The final 21-check core/tarball run preserves every helper's diagnostic function name as well as
its registered execution path; code and installed declarations use the same operation vocabulary.
Source validation passes 3,667 checks across 191 skills; VS Code typechecking and all 13 unchanged
bundle budgets pass. The gateway remains 851 modules / 6,744,893 bytes, without increasing a limit.
All repositories, remotes and machine state are fixtures. No Windows, hosted CI, provider,
installation, merge, push or real-project authority change ran.

This completes the portable inventory slice of Phase 5. Portable configuration installation and
lifecycle ports still need to consume it through storage and execution ports; the native compiler
continues to own YAML/configuration semantics for now. Remaining queries/native policy extraction,
complete namespace-backed cross-agent Stories, verified migration and authority fencing, final
cleanup/distribution and performance qualification retain their full roadmap scope. Existing Git
lifecycle, state projection, configuration and human approval authority remain unchanged.
