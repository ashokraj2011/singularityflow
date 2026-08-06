# Mobile model intake

The `figma-mobile` workflow can turn Figma MCP metadata into governed, approval-bound
design context. VS Code or Copilot owns the MCP connection, authentication, process,
and trust prompt. Singularity Flow owns the policy, copied evidence, hashes, phase
binding, and downstream provenance.

## 1. Configure and attest the host

From the governed repository:

```bash
singularity-flow mcp scaffold figma
singularity-flow mcp doctor --server figma
```

The scaffold preserves unrelated `.vscode/mcp.json` entries. `--local` selects the
Figma desktop endpoint. Review and start the server using the host's MCP controls.
After authenticating it, record the machine-local confirmation:

```bash
singularity-flow mcp attest figma --confirm figma
singularity-flow mcp doctor --server figma
```

`ready` means the current host-entry and policy hashes match that attestation. No
network probe ran, and the receipt does not prove a tool call occurred.

## 2. Capture an exact design source

During `design-intake`, ask the governed `product-designer` agent to call Figma
`get_metadata`, save the returned XML as a local file, and record it:

```bash
singularity-flow mcp record figma \
  --kind design-source \
  --tool get_metadata \
  --phase design-intake \
  --output figma-metadata.xml \
  --file-key checkout-mobile \
  --file-version v17 \
  --file-version-created-at 2026-08-06T00:00:00.000Z \
  --node 1:3
```

Flow copies the bytes under the active Story's `context/mcp/outputs/` directory and
writes a typed record under `context/mcp/records/`. The stored format is
`figma-mcp-metadata-xml`. File versions are opaque identifiers; Flow never sorts
them lexically to guess which design is newer.

## 3. Publish and approve the pinned set

Publishing the configured capture phase builds one deterministic design-source set
for that exact phase generation. Multiple candidates for one Figma file are an
error until an explicit selection is made. Approving the phase binds the exact set
path, file hash, semantic set hash, generation, and record hashes to the approval.

```bash
singularity-flow phase publish design-intake
singularity-flow approve --phase design-intake
singularity-flow mcp design-sources status
```

The set is part of the normal lifecycle publication transaction: lock, revision
check, journal, state/artifact projection, commit, and push. A failed publication
retains the normal pending-publication recovery marker.

## 4. Use it downstream

Only phases listed in the pinned `designSources.consumeIn` policy receive the
approved set. Prompt composition verifies every record and managed output, then
injects file/version/node metadata and hashes. Raw XML bytes are not copied into
the prompt. A generation-specific provenance file records the exact set used.

```yaml
designSources:
  capturePhase: design-intake
  consumeIn: [design-inventory, component-mapping, mobile-spec, visual-verification, conformance]
  staleness: warn
  requireApprovedSet: true
  inventoryDigest: optional
```

If an approved record, set, or managed output changes, the deterministic gate fails.
A newly fetched live Figma version never silently replaces the approved version; it
must become a new source set and receive a new approval.

## 5. Promote a reviewed candidate

When another design-source record is captured after approval, Visual Assurance
shows it as a candidate and preserves the current approved baseline. Promotion is
never inferred from a newer-looking version string. Review the record and hashes,
then confirm the exact record ID:

```bash
singularity-flow mcp design-sources promote mcp-RECORD-ID \
  --confirm mcp-RECORD-ID \
  --reason "Approved checkout revision"
```

The same action is available on the candidate row in the VS Code Visual Assurance
view. Flow commits and publishes the decision, reopens `design-intake`, invalidates
the capture and downstream approvals, and pins the candidate for the next capture
generation. The previous set and approvals remain in Git history. The promoted
candidate becomes authoritative only after the new generation is published and
approved.

## Provenance boundary

Flow records a declaration made by the governed agent and the hash of the copied
result. It does not intercept the MCP transport and must not claim that the record
alone proves the host executed the named tool. Credentials, headers, signed URLs,
and host environment values are not written to Git or prompt provenance.

This delivery provides the complete governed vertical slice: merge-safe host setup,
typed Figma evidence, approval-bound source sets, explicit candidate promotion,
downstream prompt provenance, readiness attestation, device-profile coverage,
deterministic RGBA8 PNG comparison, and tamper detection.
