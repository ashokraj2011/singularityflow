# Java/Maven Full World Model and Semantic AST Demo

This runbook prepares and demonstrates the richest Singularity Flow grounding available for a
Java Maven repository. It covers a semantic, reusable world model and an optional Java/JDT AST
overlay, then shows how to verify both in VS Code and Copilot.

## What the demo proves

The two intelligence paths complement one another, but they are deliberately separate:

| Intelligence | Purpose | Lifetime | Model use |
| --- | --- | --- | --- |
| Full world model | Repository architecture, development, security, testing, operations, and other configured views | Shared by all Stories at the same repository source snapshot and scope | Semantic `quick`, `standard`, or `deep` generation invokes the configured model provider |
| AST intelligence | Bounded symbols, imports, references, hierarchy, modules, and exact locations | Content-addressed for the exact Git objects, policy, provider, and project binding | Never invokes a model |

The world model is not generated from the AST. During governed prompt composition, Singularity
Flow combines the reusable world-model views with bounded AST facts when AST is available. This
keeps architectural knowledge reusable while allowing precise revision-bound code navigation.

AST is always optional. A missing JDK, JDT pack, project binding, unsupported language, adapter
failure, or disabled AST setting must produce an honest disabled or partial diagnostic. It must
not block phase publication, submission, or ordinary Copilot file access.

## Demo result

For the strongest version of the demo, prepare the following state:

- the full world model is `ready` and published on the configured state branch;
- all workflow-required views are present;
- the Java Maven project binding is complete;
- Java AST assurance is `semantic` through an installed, reviewed `sflow-java-jdt` pack;
- a second Story at the same source snapshot reuses the same world model;
- Prompt audit shows separate `world-model-grounding` and optional AST context sections.

If the optional JDT provider is unavailable, the demo can still proceed with the bundled
text-assured Java structural preview. State clearly that this is a preview, not semantic Java
analysis.

## Prerequisites

Run the demo from the application repository root—the directory that owns
`singularity/workflow.yml`—and not from a home directory or a non-governed source clone.

You need:

- Node.js 20 or newer and the current Singularity Flow installation;
- Git identity and access to the configured remote and state branch;
- a clean, committed Java Maven source revision for reproducible evidence;
- a tracked `pom.xml` inside the selected capability scope;
- Java and Maven available locally;
- `singularity/modelTiers.yml` with `analyze` and `reason` task mappings, or a model passed
  explicitly with `--model`;
- for semantic AST only, an approved offline Java/JDT provider pack and its required JDT/JDK
  toolchain.

Confirm that the shell is in the repository selected by the workspace:

```bash
singularity-flow workspace current --json
pwd
git status --short --branch
singularity-flow doctor
```

If `workspace current` reports another repository, change to its `repositoryPath` before running
any world-model or AST command.

## 1. Configure world-model generation

In VS Code, open **Singularity Flow → Configuration Center → World model**. For a deliberate,
high-quality demo, use these settings:

| Setting | Recommended demo value | Meaning |
| --- | --- | --- |
| Materialization mode | `on-demand` | A missing model can be prepared at the lifecycle boundary |
| Depth | `phase` | Generate the depth required by the active phase |
| Confirmation | `prompt` | Semantic model use remains visible and user-authorized |
| Publication | `governed` | Publish the validated model through the configured Git policy |
| Lookahead | `next-phase` | Prepare the next phase's views when policy permits |
| Grounding | `enforce` | Refuse model-grounded generation until required world-model evidence is ready |
| Staleness | `warn` | Make source drift visible without hiding the recovery path |

`grounding: enforce` applies to the world model, not AST. AST remains optional in every mode.
Use `grounding: warn` for a lower-friction demonstration where a missing world model should be
reported but not stop the phase.

For a monorepo, configure only the capability's owned source roots and required shared roots. An
empty scope means the whole application repository and can make generation slower and less focused.

Before building, verify model routing:

```bash
singularity-flow doctor --performance --offline
singularity-flow wm status --json
```

Semantic discovery views route through the `analyze` task and final synthesis routes through
`reason`. If `singularity/modelTiers.yml` is absent and the configured provider has no legacy model,
the build intentionally fails before starting discovery. Restore the reviewed task mappings or use
an explicit model for this invocation:

```bash
singularity-flow wm build --depth deep --parallel --workers 4 --model <MODEL>
```

Do not put credentials or provider secrets in `modelTiers.yml`.

The shipped mapping uses current Copilot selection (`gpt-5.4` and the provider's `auto` selector).
If a preferred model is unavailable, the runner tries only that task's reviewed fallback and records
the failed hop plus the model that actually ran. Authentication, timeout, tool-policy, and malformed
output failures never trigger a model substitution.

## 2. Build the full world model

Build the complete semantic model before the live demo. A deep build can take several minutes,
depending on repository size, view count, and provider latency.

Use the repository's declared `worldModel.views` list. The starter workflow uses the following
seven views:

```bash
singularity-flow wm build \
  --depth deep \
  --views business,architecture,development,testing,release,operations,security \
  --parallel \
  --workers 4
singularity-flow wm check
singularity-flow wm status --json
```

The build first proves one view packet end to end, then runs the remaining discovery views in
parallel, checkpoints completed views, performs one final synthesis, validates the manifest, and
follows the configured publication policy. A zero-packet preflight starts no remaining workers and
retains no empty checkpoint. It never writes model output into the application source tree.

If a build is interrupted, rerun the identical command with `--resume`. Completed packets whose
source, prompt, model, and options still match are reused:

```bash
singularity-flow wm build \
  --depth deep \
  --views business,architecture,development,testing,release,operations,security \
  --parallel \
  --workers 4 \
  --resume
```

Without `--phase` or `--views`, a repository-level build requests only the shared core selection;
`--depth deep` controls its tier but does not silently mean “every configured view.” Use the exact
configured view list above when the demo must prebuild the full catalog. A phase-specific
`wm ensure --phase <PHASE>` requests that phase's pinned view set and progressively merges it into
the same repository model.

For the active phase, verify that its exact view set is materialized:

```bash
singularity-flow wm ensure --phase implementation --json
singularity-flow wm check
```

Replace `implementation` with the phase being shown. A normal lifecycle command does not turn the
Story title into an ad-hoc world-model task. Use `--task` only when the demo deliberately needs a
separate task guide.

### Copilot equivalent

Use `/sf-worldmodel` and ask:

```text
Build the deep world model for the current repository, with all workflow-required views. Show the
resolved model routing, source hash, generated views, publication result, and whether existing
views were reused. Do not add an ad-hoc task guide.
```

The skill should resolve the active workspace repository first and show the command and governed
confirmation. For a predictable live demo, perform the long build in advance and use Copilot for
status, checking, and bounded queries.

### Where publication goes when no Story is active

`wm build`, `wm light`, `wm status`, `wm check`, and `wm ensure` are repository operations. They do
not require a Story and they do not create a Story workflow. They read the existing approved
`singularity/workflow.yml` from the selected repository.

A non-local governed build uses this topology:

```text
temporary analysis checkout
        │ validated model
        ▼
remote state branch (authoritative shared copy)
        │
        └── singularity/world-model/**

current non-protected application branch (auditable branch copy)
        │
        └── singularity/world-model/** + world-model commit + branch push
```

The state branch is `ledger.branch` when configured and otherwise defaults to `state`. The remote
comes from the ledger/world-model configuration or `git.remote`, normally `origin`. Readers prefer
the state-branch copy, which is why a new Story or another laptop can reuse it.

The second copy is installed at `worldModel.outputDir`, normally `singularity/world-model`, then
committed and pushed on the branch currently checked out. With no active Story, Singularity Flow
does not invent a work branch. It refuses a publishing build on `main`, `master`, the configured
default branch, or the remote default branch. Prepare a dedicated non-protected branch first, for
example:

```bash
git switch -c wm/java-maven-demo
singularity-flow wm build \
  --depth deep \
  --views business,architecture,development,testing,release,operations,security \
  --parallel \
  --workers 4
```

`--local` skips state-branch publication and remote push, but it still records the validated model
as a local commit on the current branch. Use a dedicated branch even for a local rehearsal if the
local default branch must remain untouched.

There is currently no `state-only` build option: governed publication writes the authoritative
state-branch snapshot and the auditable current-branch copy. No files are created under
`singularity/work-items/` unless a separate Story lifecycle command is run.

## 3. Prove world-model reuse

The governed model belongs to the repository source snapshot and scope, not to one Story. Story
artifacts are excluded from the application source fingerprint.

Capture the ready status:

```bash
singularity-flow wm status --json
singularity-flow wm ensure --phase implementation --json
```

Then attach or start another Story without changing the application source revision and run the
same commands again. The second check should resolve the same source tree and reuse the valid
published views rather than invoke the provider again.

The proof should record:

- identical repository source-tree hash;
- identical published world-model commit or generation selection;
- required views reported as ready;
- no new semantic discovery or synthesis invocation for the unchanged selections;
- the new Story's own phase context composed separately from the shared model.

`wm status`, `wm check`, and VS Code refresh are read-only and never invoke a model. Regeneration is
correct only when the application source snapshot, selected capability scope, relevant world-model
configuration, or required view selection changes—or when the user explicitly requests a rebuild.

## 4. Prepare Java semantic AST intelligence

First inspect the effective policy and installed providers:

```bash
singularity-flow wm ast doctor --json
singularity-flow wm ast pack list --json
singularity-flow wm ast pack doctor sflow-java-jdt --json
```

The bundled legacy-named `sflow-polyglot-syntax` scanner provides a useful Java declaration and
relationship preview, but its assurance is `text`: it is not a Java parser. The semantic
`sflow-java-jdt` engine is an optional pack and may not be installed on a new machine.

### Install a reviewed offline JDT pack

Repository configuration can select a provider ID but cannot register an executable. Install only
an approved local manifest or archive. Preview first:

```bash
singularity-flow wm ast pack install /approved/offline/sflow-java-jdt-pack.tgz --dry-run
```

Review its provider identity, executable/package digests, runtime, grammar and dependencies. Then
rerun the command with the exact content-bound confirmation phrase printed by the preview:

```bash
singularity-flow wm ast pack install /approved/offline/sflow-java-jdt-pack.tgz \
  --confirm "<EXACT CONFIRMATION FROM DRY RUN>"
```

Do not invent or reuse an old confirmation phrase.

### Select semantic Java assurance

Use **Configuration Center → AST intelligence** to select the Java semantic provider. The
equivalent policy shape is:

```yaml
ast:
  mode: auto
  fallback: host-and-text
  languages:
    java:
      mode: auto
      minimumAssurance: semantic
      semanticProvider: sflow-java-jdt
      semanticProfile: default
```

If the provider or binding is unavailable, this policy reports partial coverage and falls back to
ordinary file/text access. It does not create a lifecycle gate.

## 5. Complete the Maven project binding

A project binding tells JDT which Maven root, modules, source sets, build metadata, profile, JDK,
and toolchain digests define the program. Installing the pack alone is not sufficient.

Preview the bounded offline warm-up:

```bash
singularity-flow wm ast warm --semantic \
  --provider sflow-java-jdt \
  --project maven:. \
  --profile default \
  --dry-run \
  --json
```

Review every structured command. Warm-up may run disclosed offline project-model and toolchain
commands, such as Java version inspection or an offline Maven effective-model read. It must not
download dependencies, run repository scripts, or invoke a model.

Run the exact command again with the digest-bound confirmation printed by the preview:

```bash
singularity-flow wm ast warm --semantic \
  --provider sflow-java-jdt \
  --project maven:. \
  --profile default \
  --confirm "<EXACT CONFIRMATION FROM DRY RUN>" \
  --json
```

Verify the result:

```bash
singularity-flow wm ast doctor --json
singularity-flow wm ast pack doctor sflow-java-jdt --json
```

For the semantic portion of the demo, the provider, project-model binding, toolchain binding, and
selected profile should all be available. If warm-up times out or fails, no binding is written.
Fix the local JDK, Maven offline cache, profile, or pack toolchain and preview again; do not retry in
an automatic loop.

## 6. Build and query bounded AST context

Populate the local content-addressed AST cache for application and test sources:

```bash
singularity-flow wm ast build --paths src/main/java --paths src/test/java --json
```

If the result returns a resume handle because of a file or byte budget, continue that exact job:

```bash
singularity-flow wm ast build --resume <HANDLE> --json
```

Do not replace the handle with `--all`; that changes the reviewed cone.

Run a symbol query using a real type in the demonstration project:

```bash
singularity-flow wm ast query \
  --predicate symbol \
  --value InterestCalculationService \
  --paths src/main/java \
  --max-facts 50 \
  --max-output-bytes 32768 \
  --json
```

Use a returned symbol ID for reference and hierarchy queries:

```bash
singularity-flow wm ast query --predicate references --value <SYMBOL-ID> --paths src --json
singularity-flow wm ast query --predicate hierarchy --value <SYMBOL-ID> --paths src --json
singularity-flow wm ast query --predicate module --value <MODULE> --paths src --json
```

Queries are bounded, contain no source bodies, and do not fill the cache. Only `wm ast build` writes
cache records. For durable reproducible AST evidence, the selected files must be exact committed
Git objects. Dirty or untracked in-cone paths make the evidence partial or unavailable rather than
failing the Story.

## 7. Configure workflows to use both paths

Each work type can declare the intelligence it benefits from:

```yaml
workTypes:
  feature:
    intelligence:
      worldModel: required
      ast: optional-context
      agentBriefs: required
```

Use `optional-context` to make the intent explicit. The compatibility value `required-context`
still means an explicitly requested AST diagnostic can report that a predicate is unmet; it does
not authorize AST to block publication, submission, readiness, or lifecycle progress.

The World Model Explorer displays which world-model views are inherited, added, overridden, or
disabled for each phase in each workflow. AST context is shown separately because it is a bounded
optional overlay, not a durable world-model view.

## 8. Live VS Code demo script

1. Open **Configuration Center → World model**.
2. Show the readiness card: source is the configured state branch, status is `ready`, and the
   source revision matches the application repository.
3. Show the view catalog and filter it to architecture, development, testing, security, or another
   audience-relevant view.
4. Show the workflow-by-view matrix. Explain inherited, phase-added, overridden, and disabled
   cells by selecting representative phases.
5. Open **Configuration Center → AST intelligence**. Show Java's effective provider, semantic
   assurance, Maven project-model binding, toolchain binding, and profile.
6. Run one symbol query and one references or hierarchy query through `/sf-worldmodel` or the CLI.
7. Attach the demonstration Story and run `/sf-next`. Confirm that the phase uses the already-ready
   shared world model and adds only current Story/phase context.
8. Enable Prompt audit with `/sf-prompt-log on`, compose the governed prompt, and open
   **Configuration → Prompt audit**.
9. Show the structured world-model grounding section and optional AST facts separately. Compare
   fact counts and payload bytes; do not claim a token saving that has not been measured.
10. Attach a second Story at the same source revision. Refresh the Explorer and show reuse of the
    same model without another provider build.

## 9. Measure the value honestly

For a useful AST-versus-no-AST comparison, run the same task twice against the same committed
revision and model, changing only AST availability. Keep the world-model selection constant.

Compare:

- prompt input tokens and managed context bytes;
- AST fact and payload counts;
- tool calls for glob, text search, file reads, and bounded AST queries;
- time to locate the relevant declaration and references;
- output correctness and test results;
- model invocation count and provider cost.

The AST arm is useful only if high-value structural facts are ranked into the bounded context. A
page dominated by file-inventory facts is not evidence of AST value. Inspect Prompt audit to verify
that symbols, imports, relationships, references, or hierarchy facts were actually included.

AST itself consumes zero model tokens. It may reduce later model context or repository-search tool
calls, but that saving must be shown by the controlled comparison rather than assumed.

## 10. Recovery and safe fallback

### Model routing is missing

Restore the reviewed `singularity/modelTiers.yml` task mappings or pass `--model` explicitly. For a
zero-token inventory fallback, run:

```bash
singularity-flow wm build --depth light --phase implementation --local
```

Light mode is a deterministic file/build-manifest inventory. Do not present it as semantic
architecture or code understanding.

### Semantic world-model generation is interrupted

Rerun the identical build with `--resume`. If a killed process left a temporary analysis worktree,
inspect it first and then run:

```bash
singularity-flow wm cleanup --json
```

### Validation succeeded but publication failed

Reuse the retained validated bytes without invoking the provider again:

```bash
singularity-flow wm recovery list
singularity-flow wm recovery inspect <ID>
singularity-flow wm recovery publish <ID> --confirm <ID>
```

### JDT is unavailable or project binding is incomplete

Continue the demonstration with the bundled text-assured preview or turn AST off:

```bash
singularity-flow wm ast preference set off
```

Return to automatic optional AST later with:

```bash
singularity-flow wm ast preference set auto
```

Neither choice changes the world model or lifecycle authority.

### The command reports missing `singularity/workflow.yml`

The shell is in the wrong checkout, commonly the application source clone instead of its governed
Story worktree. Resolve the selected repository and change directory:

```bash
singularity-flow workspace current --json
cd "<repositoryPath from workspace current>"
```

Do not initialize a second copy just to bypass this error.

## Demo checklist

- [ ] Application source is committed and the governed repository is selected.
- [ ] Model routing resolves both `analyze` and `reason`.
- [ ] Deep world-model build is validated and published.
- [ ] Explorer reports `ready` and shows all required views.
- [ ] A second `wm ensure` reuses the unchanged snapshot.
- [ ] Approved JDT pack is installed, or the demo is clearly labeled text-preview-only.
- [ ] Maven project and toolchain bindings are complete for semantic AST.
- [ ] AST cache is built for `src/main/java` and `src/test/java`.
- [ ] Symbol and reference queries return structural facts rather than a file inventory page.
- [ ] Workflow uses `worldModel: required` and `ast: optional-context`.
- [ ] Prompt audit shows world-model and AST sections separately.
- [ ] Second Story demonstrates shared world-model reuse.
- [ ] Failure paths fall back safely and never make AST a lifecycle blocker.

## Related documentation

- [World model grounding and views](docs/topics/world-model.md)
- [AST Intelligence](docs/AST-INTELLIGENCE.md)
- [AST project binding](docs/topics/project-binding.md)
- [Model independence and manual authorship](docs/MODEL-INDEPENDENCE.md)
- [How Singularity Flow works](FRAMEWORK-GUIDE.md)
