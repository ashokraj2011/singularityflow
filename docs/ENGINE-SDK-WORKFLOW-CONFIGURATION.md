# Workflow configuration compiler boundary

The kernel owns the definition and resolution rules formerly embedded in `config.mjs`:
phase producer admission, planned-claim ownership, generation and input policies, workflow
overrides, design and verification policy, definition validation, and effective workflow resolution.
`config.mjs` keeps checkout discovery, YAML and asset loading, catalog observation, diagnostics,
snapshot capture and initialization. These remain the installed Git-backed path.

`createWorkflowConfigurationCompiler` is an internal composition function. Its construction-time
collaborators are the existing packaged policy validators, catalog interpreters and explicit path
grammar. Every collaborator is required, captured once and checked for an ordinary own data
property; missing, inherited, accessor and unknown fields are refused. Callers cannot pass this
composition through an engine operation. The installed adapter is its only production constructor.
This boundary does not accept a `ready` callback, confer approval, enroll a project, write a
configuration record or select a storage authority.

Shared approval, phase, clarification, routing and source-review rules are direct kernel imports.
The remaining native policy libraries are named compatibility dependencies, not replacement
validators. In particular, the opt-in commit-policy runtime loader remains outside the kernel and
runs at the same validation checkpoint. Its error object is propagated unchanged. The compiler
keeps the existing in-place normalization contract and property order, including mutations before
a refusal. No Story changes or new configuration versions are introduced by this extraction.

`mergePhaseOverride` has one kernel implementation. The old module re-exports the same function;
the Studio/markup compiler uses that implementation directly. Compiler build identity, VSIX source
requirements and both workflow-intent interpretation digests include the new owner, so a changed
rule cannot retain a stale advisory identity just because the compatibility alias is unchanged.

Qualification compares 43 captured results from `4316ab52f`, including normalized definitions,
all 18 packaged workflow resolutions, and exact refusal codes, messages, details and mutation
order. Syntax fingerprints cover all 29 moved rule bodies, allowing only the explicit native
runtime-loader handoff in definition validation. Additional checks use the real installed
collaborators to exercise reviewer catalogs, compiler construction, immutable collaborator capture,
platform path grammar, authority constraints and unchanged runtime errors. Native configuration,
SKP, markup, intent, source-closure and full Story tests qualify the installed path.

The Mac qualification run passed 340 tests across 28 files, with no failures, cancellations or
skips, including complete native Story journeys and the installable SDK archive. Source validation
passed 3,720 checks, VS Code typechecking passed, and the Git audit retained 2,011 observed sites
with no new bypasses. All 13 bundle budgets passed unchanged; the gateway has 852 modules and
6,803,780 bytes. These are compatibility and distribution checks, not a claim of command latency
improvement or completed namespace lifecycle execution. No Windows or live-provider run was used.

This is part of Phase 5, not completion of portable execution. The compatibility policy libraries
still need their remaining host-independent rules extracted before this compiler can be the default
compiler of a packaged namespace runtime. Phase 7 also still requires authenticated project
enrollment, Story creation and production lifecycle ports. A storage fixture seeded with a head
and configuration does not satisfy those requirements. Verified migration and authority cutover
remain Phase 8, and distribution/performance qualification remains Phase 9.
