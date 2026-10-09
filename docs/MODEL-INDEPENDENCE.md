# Model independence and manual authorship

Singularity Flow's workflow kernel does not require a language model. Git state,
phase sequencing, validation, publication, approvals, reports, deterministic world
models, and manual artifacts can all run with model mode disabled.

## Disable model execution

For one command:

```bash
singularity-flow --no-model status
singularity-flow --no-model phase publish intake --authored human --from ./intake.md
```

For a shell or CI job:

```bash
export SINGULARITY_FLOW_NO_MODEL=1
singularity-flow doctor
```

VS Code exposes the same choice as `singularityFlow.modelMode` with `auto` and
`disabled` values. The Configuration tree reports whether the current phase has a
complete model-free path and explains blockers instead of silently invoking a
provider.

Every public operation has an explicit `never`, `optional`, or `required` model
policy. Classification occurs before its handler module is imported. A `never`
operation cannot invoke a model, including through a nested helper. A `required`
operation fails before execution when model mode is disabled. The generated
[operation catalog](OPERATION-MODEL-POLICY.md) is the authoritative inventory.

`wm build` is deterministic by default: with the default deterministic composer it
runs as `wm.build.deterministic` and calls no model. Only a configured
`worldModel.v4.composer: model-optional` or `model-required` (or the matching
`--composer` option) may call one. `wm ensure` is a read-only readiness check and
never builds. `next` reuses an exact governed selection first; when the
Story's pinned materialization policy requests `depth: light`, it runs the
deterministic registered build at `quick` depth. With `--no-model`, these paths
stay deterministic and never invoke the provider.

Previews that prove they are deterministic are classified by their actual work:
`copilot --dry-run`, `workspace copilot --dry-run`, and `workspace
impact analyze --dry-run` have separate preview operation IDs and run with
`--no-model`; permission is checked only when a real host or analysis process is
about to start.

A state-branch, installation, commit, or push failure is reported as publication
recovery and never starts a replacement build. With `lookahead: next-phase`, a successful `next` also ensures the
next pinned phase plan after the current one.

When publication fails after validation, the validated snapshot is retained under
the repository's private `.git/singularity-flow/world-model-v4-recovery/` area, with an ID that
starts with `wmb4-`. A recovery ID retained by the removed legacy-v3 builder is refused. The
reported error keeps the original synchronization instruction; these recovery
snapshots are never treated as governed context until normal publication succeeds.
List them with `singularity-flow wm recovery list`, inspect the exact retained manifest with
`wm recovery inspect <ID>`, and republish the validated bytes—without another provider call—with
`wm recovery publish <ID> --confirm <ID>`. Publication rechecks the recorded state authority
and source guard before it writes.

## Publish manually authored artifacts

Prepare the phase, edit its artifact in place, and publish it as human-authored:

```bash
singularity-flow prepare intake
singularity-flow phase publish intake --authored human --channel manual-in-place
```

Or import an existing file without modifying the source:

```bash
singularity-flow phase publish intake \
  --authored human \
  --from ./approved-intake.md \
  --channel manual-import \
  --external-ai none
```

The engine validates the resolved phase contract: file type, media type, byte
limits, required headings, forbidden placeholders, write scope, inputs, and quality
commands. It strips old managed metadata from imported text, preserves binary bytes
exactly, rejects symbolic links, records source hashes and channel provenance, then
uses the same atomic commit/push transaction as governed-agent output.

Human authorship does not pretend to prove how the text was produced. Kernel model
use is exact and auditable. External AI use is explicitly self-reported as `none` or
`assisted`, or recorded as unavailable when omitted.

## External quality commands

Prefer structured commands:

```yaml
noModel:
  unknownExternalCommands: warn # or block

phases:
  verify:
    qualityCommands:
      - id: unit-tests
        argv: [npm, test]
        modelPolicy: never
```

`modelPolicy` is `never`, `required`, or `unknown`. In disabled mode, `never`
commands run, `required` commands block, and `unknown` commands are skipped with a
warning or blocked according to `noModel.unknownExternalCommands`. Structured
`argv` execution avoids shell interpretation.

## Trust boundary

The kernel owns bounded provider invocation through `model-runner.mjs`. Prompt
fingerprints, provider/model identity, tool policy, limits, result hashes, and usage
availability are recorded under `.git/singularity-flow/model-invocations/` before
and after execution. Audit-write failure prevents provider startup.

A kernel operation can send several prompts through one model session
(`createModelSession()` passed as `session` to `invokeModel`). The prompts share one
Copilot ACP process and conversation, so a follow-up reads the session's earlier
text, including Copilot's ~11,400-token built-in prompt, from the provider cache
instead of paying for it again. Each prompt is still staged, verified, limited and
audited as its own invocation; its record carries `session: { id, turn }` and the
usage for that turn alone. A session accepts only prompts with the same provider,
model, folder, allowed roots and tool policy, up to its turn limit (default 6). A
failed prompt closes the session, and the next prompt must start a new one. Only
the ACP transport has sessions; other transports run each prompt on its own.

Interactive Copilot hosting is a separate boundary. Singularity Flow can compose
and hand off governed context, but it does not claim control over model calls made
by VS Code, Copilot extensions, MCP servers, or other external hosts. Reports label
that surface `outside-guarantee`.

## Maintainer checks

```bash
npm run audit:model-boundary
npm run operation-catalog:check
npm test
npm run check
```

The boundary audit rejects direct provider launches outside the registered provider
and interactive-host adapters. The operation catalog check rejects documentation
drift.
