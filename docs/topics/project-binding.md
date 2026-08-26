---
id: project-binding
title: AST project binding
aliases:
  - semantic-binding
  - project-model-binding
questions:
  - What is project binding?
  - Why is semantic assurance degraded?
  - How do I complete a project binding?
keywords:
  - maven
  - gradle
  - toolchain
  - source sets
  - modules
  - incomplete binding
commands:
  - wm
related:
  - ast-intelligence
  - world-model
  - diagnostics-and-regression
version: 1
---
A project binding is the immutable description an optional semantic AST provider needs to interpret
source in the correct build context. It binds the project kind and root, build files and lockfiles,
modules, source sets, toolchain identity, provider profile, and their digests. Without that context,
a semantic engine could confidently analyze the wrong classpath, variant, or dependency graph.

## Purpose and prerequisites

Use this topic when AST diagnostics report an incomplete project binding or semantic assurance is
unavailable. A project binding is not required for normal Copilot file access, text grounding, or
any lifecycle transition. An installed reviewed semantic provider and its local toolchain are
prerequisites only when semantic assurance is explicitly wanted.

## Use it from each surface

- **Shell:** run `sflow wm ast doctor --json` to inspect discovery; preview semantic warm-up with `sflow wm ast warm --semantic ... --dry-run`.
- **Copilot:** use `/sf-worldmodel` for the read-only binding/provider matrix; do not let Copilot approve or invent a warm-up confirmation.
- **VS Code:** open **Singularity Flow → Configuration → AST intelligence** and inspect the project-model and toolchain rows for the selected repository.

## Guided workflow

Singularity Flow discovers existing Maven, Gradle/Android, Python, SwiftPM, and Xcode metadata from
the repository. Discovery is bounded and existing-only: it does not execute a build tool, resolve
dependencies, download packages, run repository scripts, or invoke a model.

Run `sflow wm ast doctor --json` to see discovered bindings and the exact missing boundary. An
incomplete binding keeps text or syntax evidence available but reports why semantic assurance is
unavailable or degraded.

## Completing a semantic binding

Semantic warm-up is an explicit, reviewed mutation because it may run provider-specific offline
project-model and toolchain commands and then save their content-bound identity. Preview the exact
plan first, for example:

`sflow wm ast warm --semantic --provider sflow-java-jdt --project maven:. --profile default --dry-run`

Review the structured commands, repository changes, provider, project, profile, and digest-bound
confirmation emitted by that preview. Use only an installed, reviewed provider and the exact
confirmation returned by the command. Normal `status`, `context`, `query`, and `gate` reads never
warm a project or resolve dependencies.

## State and safety

An absent or incomplete binding never blocks ordinary Copilot file access or a Singularity Flow
lifecycle transition. The AST result becomes partial or unavailable, retains its honest assurance
label, and falls back according to policy. Do not describe a text preview as semantic evidence.
The saved binding is content-bound to the discovered project metadata, provider, profile, toolchain,
and command plan. A later mismatch is unavailable rather than silently reused.

## Troubleshooting

- If no binding is discovered, verify the relevant build metadata is tracked and inside the selected capability cone.
- If `explicit-toolchain-binding` is unavailable, install or select the reviewed provider toolchain and preview warm-up again.
- If `module-profile-binding` is unavailable, choose the actual Maven/Gradle/Android profile rather than accepting a guessed default.
- If warm-up fails, retain the partial diagnostic and continue through text/file access; do not rerun builds in a loop.

## Related topics

Continue with `sflow explain ast-intelligence`, `sflow explain world-model`, or
`sflow explain diagnostics-and-regression`.
