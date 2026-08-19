# Self-provisioning usage telemetry

Singularity Flow captures provider-reported usage only for agent processes it launches and can bind to a repository, Story, and opaque launch ID. Telemetry is local, metadata-only, non-governing, and disabled for the launch until the current disclosure has been accepted.

## Supported hosts

| Surface | Mode | Current result |
|---|---|---|
| `sflow copilot` / `workspace copilot` | launch injection | Separate local file stream per process |
| VS Code **Continue with Copilot CLI** | launch injection | Same Node launcher in an integrated terminal |
| IntelliJ integrated terminal invoking `sflow copilot` | launch injection | Same portable CLI contract |
| Native VS Code Copilot Chat | native configuration | Not provisioned by this build; usage unavailable |
| Native JetBrains Copilot / AI Assistant | external only | Usage unavailable locally |
| Manually invoked `copilot` | none | Never instrumented by SFlow |

Run `singularity-flow telemetry probe --json` for the versioned capability result. Unknown provider, runtime, or host combinations fail closed to `none`.

## Consent and privacy

Before the first captured process, run `singularity-flow telemetry enable` or accept the same disclosure when `sflow copilot` prompts. The acceptance is machine-local and bound to a digest of the collection policy. `singularity-flow telemetry disable` affects future launches only and never changes lifecycle state.

The SFlow exporter forces both standard and provider content-capture controls off. Normalized records allow only provider/runtime/model identifiers, token counts, timestamps, duration/status, provider-emitted cost signals, and aggregate tool categories. Prompts, responses, instructions, source, file contents, tool arguments/results, conversation identifiers, and HTTP bodies are dropped with a content-free privacy diagnostic.

Existing OTLP endpoints, authentication headers, exporter settings, and managed content policy are never overwritten. Unsafe composition produces `conflict`; forced content capture produces `blocked-by-content-policy`. Both allow governed work to continue without local ingestion.

## Storage and attribution

Every process receives a unique stream:

```text
<git-common-dir>/singularity-flow/telemetry/
  launches/<launch-id>.json
  raw/github-copilot/<launch-id>.jsonl
```

Launch records contain hashes and repository-relative control paths, not prompts or checkout paths. Raw streams never enter Git. At lifecycle boundaries, reconciliation joins only launch-bound events and writes the sanitized phase summary to:

```text
singularity/work-items/<WORK-ID>/telemetry/<phase>-gen<N>.json
```

Configured without an observed valid event is `partial`, never `captured`. Mixed captured and unavailable launches remain visibly partial. Missing provider values remain missing and are never converted to zero.

## Commands

```bash
singularity-flow telemetry probe
singularity-flow telemetry enable
singularity-flow copilot
singularity-flow telemetry status
singularity-flow telemetry reconcile <PHASE>
singularity-flow telemetry disable
```

`singularity-flow doctor` reports the effective launch capability and qualified coverage. `singularity-flow doctor --fix telemetry` performs only the same machine-local disclosure/enable operation; it does not modify IDE settings or shell profiles.

The provider contracts are grounded in GitHub's official Copilot CLI OpenTelemetry reference and the [VS Code agent OpenTelemetry guide](https://code.visualstudio.com/docs/agents/guides/monitoring-agents). Native host provisioning remains unavailable until a documented, consent-safe adapter is implemented and tested.
