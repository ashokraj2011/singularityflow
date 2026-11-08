# Shared configuration policy rules

Sixteen compiler dependencies now use the real kernel validators directly. They cover session
selection policy, template catalog interpretation, repair limits, work-type intelligence, task
classification, bounded context policy, test runtime settings, token policy, code-delivery policy,
specification policy and document storage policy. The compiler no longer accepts replacement
callbacks for these rules. Its remaining 51 compatibility collaborators still need their own
extraction or explicit host-capability boundary before the portable compiler is complete.

`kernel/configuration-policy.mjs` owns 39 unchanged rule bodies from twelve native modules. The
native modules retain their exported API and re-export the same function and policy objects.
Existing production consumers use the kernel exports directly. Native execution and presentation
remain in their previous owners: context handoff rendering, test-process environment and hashes,
token-policy digesting, specification file/evidence inspection, application-review record readers,
and repair-budget consumption and its existing recovery guidance.

The shared module imports only the foundation error contract. Importing or running its validators
does not load Git, a checkout, a configuration branch, a filesystem, a provider, a runtime process or
a schema migration reader. It interprets data; it does not approve, publish, create a project, select
an authority or execute a test. Existing `git`/`local` document-policy labels keep their current
meaning; they are not silently reinterpreted as a namespace migration or another storage backend.

Compatibility evidence includes 60 captured policy outcomes from `afa767fdc`, all 39 original rule
body fingerprints, native/kernel export identity, policy immutability and unmodified caller inputs.
The earlier 43 full compiler observations still cover all 18 packaged workflow resolutions and
exact refusals. Constructor tests reject attempts to replace any of these sixteen shared rules.
Architecture checks enforce the pure dependency graph, alias ownership and the separation from
native rendering/execution. Build identity, VSIX requirements and workflow-intent interpretation
digests include the new rule owner.

Mac qualification passed 498 tests across 40 files with no failures, cancellations or skips. The
run includes full native Story journeys, source-review and repair constraints, local document
handoff, public SDK archives and VS Code payload qualification. Source validation passed 3,723
checks, VS Code typechecking passed, and the Git audit retained 2,011 observed sites without new
bypasses. All 13 bundle budgets passed with their limits unchanged. The gateway decreased from
852 to 847 modules and from 6,803,780 to 6,802,417 bytes; these counts do not establish command
latency improvements. No Windows, live provider, installed application or real Story was changed.

This advances Phase 5 toward the default compiler needed by Phase 7. It does not complete portable
project enrollment, production lifecycle ports, a headless Story or verified authority migration.
Those milestones retain their original scope.
