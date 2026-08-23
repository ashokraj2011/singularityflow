---
id: telemetry-and-cost
title: Telemetry, tokens, and cost
version: 6
aliases:
  - tokens
  - cost
  - cache
commands:
  - telemetry
  - copilot
  - context
  - tokens
related:
  - impact-framework
  - model-independence
  - reference-previews
---
Token accounting is exact where the provider supplies it and labeled `unavailable` where it does not—never converted to zero. `sflow copilot` and `sflow workspace copilot` provision a separate metadata-only file stream for each SFlow-owned Copilot CLI process after one machine-local disclosure. Manual Copilot and native IDE chat remain usable but are not attributed to that launch. `sflow telemetry status` shows captured, partial, unavailable, conflict, and disabled coverage; `sflow telemetry reconcile` compares completed provider events against a phase. `sflow context xray` and `sflow tokens status|report|compare` read the resulting content-free observations without reconciling or mutating them. `sflow context compile|expand` use the same deterministic kernel and write only sealed handles and content-free accounting under the Git common directory.

## Purpose and prerequisites

Use this topic when the current goal matches **telemetry and cost**. Start in a governed checkout unless the command explicitly operates on installation or machine-local workspace state. Run `sflow doctor` when setup, identity, credentials, or repository health is uncertain, and use `sflow status` or `sflow home` to confirm the selected work before a mutation.

## Use it from each surface

- **Shell:** launch with `sflow copilot`; inspect or control capture with `sflow telemetry`. Read the current phase with `sflow context xray`, or the whole-Story ledger with `sflow tokens report`. Run `singularity-flow telemetry --help` for exact forms.
- **Copilot:** `/sf-telemetry`. The skill must preserve the CLI result and ask before any governed mutation.
- **VS Code:** **Continue with Copilot CLI** opens the metered SFlow launcher in an integrated terminal. **Open Native Copilot Chat** remains available with an honest “usage unavailable” qualification.

## Guided workflow

1. Run `sflow telemetry probe` to see the documented capability for CLI, VS Code terminal, native VS Code, IntelliJ terminal, and native IntelliJ.
2. Run `sflow telemetry enable`, read the disclosure, and type `ENABLE LOCAL USAGE` if you want local capture. Declining never blocks work.
3. Start the agent with `sflow copilot` or the VS Code **Continue with Copilot CLI** action. Each process gets an opaque launch ID and separate raw stream under the Git common directory.
4. Run `sflow telemetry status`. A configured launch is only `captured` after at least one valid event is observed.
5. At a lifecycle boundary, run `sflow telemetry reconcile [PHASE]` when automatic reconciliation reports a pending generation.
6. Run `sflow context xray [WORK-ID]` to inspect the current phase, or `sflow tokens report [WORK-ID]` for whole-Story totals. Add `--phase PHASE` to narrow either projection and `--json` to retain every metric envelope. Use `sflow context doctor` to inspect the observe/assist/enforce policy and selected budget profile.
7. For a pre-registered IMP study, run `sflow tokens compare --study STUDY-ID`. A token reduction with a regressed quality floor is `cheaper-but-worse`, never an improvement.

## State and safety

`telemetry enable` and `telemetry disable` change only a machine-local preference. Reconciliation may commit a sanitized phase summary, but raw streams and launch records stay under the Git common directory and never enter Git. Provisioning preserves existing endpoints and headers, forces content capture off for SFlow-owned streams, and never affects lifecycle authorization, approvals, submission, or release.

Context X-Ray and Token Ledger projections are read-only. They do not invoke a model, request expansion, rerun a tool, reconcile a provider stream, or change lifecycle state. Packet compilation and sealed expansion are explicit, model-free machine-local mutations. Requested and resolved model identities stay separate. Provider metrics carry field-level `exact`, `partial`, or `unavailable` status and assurance; SFlow's UTF-8 byte estimates are labeled `estimated` with `sflow-estimated` assurance. Provider usage and SFlow estimates are never added into a false combined total.

## Troubleshooting

- `disclosure-required`: run `sflow telemetry enable`, or continue unmetered.
- `conflict`: an existing OTEL endpoint, exporter, or authentication configuration was preserved. Review `sflow telemetry probe`; secret values are never rendered.
- `blocked-by-content-policy`: existing policy forces content capture, so SFlow refuses to ingest the stream while allowing work to continue.
- `partial`: finish the Copilot turn and reconcile again. An interrupted launch remains partial rather than inventing zero usage.
- Native IDE chat is `unavailable` until a documented, consented adapter provides a trustworthy local join. Use **Continue with Copilot CLI** when exact local attribution matters.

## Related topics

Continue with `sflow explain impact-framework`, `sflow explain model-independence`, `sflow explain reference-previews`.
