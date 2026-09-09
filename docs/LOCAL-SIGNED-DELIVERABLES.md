# Local signed deliverables

Local mode creates a private, governed output Story without selecting or changing a product Git
repository. It is intended for bounded deliverables such as SQL conversions, schema packs,
documents, notebooks, data files, and generated model artifacts.

This is the L1 local-filesystem profile. It provides exact input/output capture, a private Git
ledger, deterministic integrity evidence, explicit standalone review, an Ed25519/DSSE signed ZIP,
create-only delivery, interruption recovery, and offline recorded-evidence audit. It does **not**
claim that the output is semantically correct: the built-in witness proves exact frozen bytes and
membership only. It also does not implement remote devices, folder export, automatic cleanup,
bundle rerun, or repository adoption. Those remain separately gated L2/L3 capabilities.

## Trust and storage

By default private state is stored below:

```text
~/.singularity-flow/local-mode/
```

Override it with an absolute `SINGULARITY_FLOW_LOCAL_MODE_ROOT`. The directory is private and is
never pushed to a product repository. Each `LOC-*` Story has its own Git ledger, content-addressed
objects, working output folder, and staging area.

Local exports are allowed only below `SINGULARITY_FLOW_LOCAL_EXPORT_ROOT`, defaulting to:

```text
~/.singularity-flow/local-mode/exports/
```

The signer private key stays in the Story ledger's Git-private sidecar. It is mode `0600` on POSIX
and DPAPI-protected for the current Windows user. A bundle contains no private key and no product
repository credentials. Export the public key separately for an independent auditor.

## Complete model-free workflow

These commands can be run from any directory. They do not discover a workspace, invoke a model,
build AST, build a world model, probe a remote, or execute content from a bundle.

```bash
# 1. Capture explicit inputs and create a private Story.
singularity-flow local start conversion \
  --intent "Convert the reviewed SQL inputs into the requested output format" \
  --input /absolute/path/source-sql \
  --input /absolute/path/schema.json \
  --classification internal \
  --json

# 2. Write the result into the outputDirectory returned above, then freeze it.
singularity-flow local freeze --story LOC-... --json

# 3. Verify the exact frozen input/output object closure.
singularity-flow local verify \
  --story LOC-... \
  --candidate sha256:... \
  --json

# 4. Create a standalone local signer and export only its public key.
singularity-flow local signer-create \
  --story LOC-... \
  --signer local-owner \
  --json

singularity-flow local trust-export \
  --story LOC-... \
  --signer local-owner \
  --out /absolute/path/local-owner-public.pem \
  --json

# 5. Sign an approval of the exact Candidate and its recorded evidence.
singularity-flow local review \
  --story LOC-... \
  --candidate sha256:... \
  --signer local-owner \
  --json

# 6. Publish below the approved export root. Existing different bytes are never replaced.
singularity-flow local publish \
  --story LOC-... \
  --candidate sha256:... \
  --signer local-owner \
  --destination /absolute/approved/export/directory \
  --format loc.zip.store.v1 \
  --json

# 7. Audit elsewhere using independently supplied public-key bytes.
singularity-flow local audit \
  --bundle /absolute/path/LOC-....sflow-local.zip \
  --trust-key /absolute/path/local-owner-public.pem \
  --signer local-owner \
  --offline \
  --json
```

Use `singularity-flow local list` and `singularity-flow local status --story LOC-...` to find local
work. Publication records the operation before the external filesystem effect. An identical retry
reconciles exact existing bytes and completes the retained receipt; a different object at the final
name is refused.

## What an offline audit means

The JSON result intentionally reports separate states:

- `integrity` verifies the bounded archive, canonical records, complete signed inventory, and all
  input/output bytes without extraction.
- `signatureTrust` verifies DSSE/Ed25519 against the public key supplied by the auditor. The trust
  scope is `standalone`, never enterprise authority.
- `evidenceBinding` proves the deterministic exact-tree observation and explicitly says semantic
  correctness is not claimed.
- `historicalPolicy` evaluates the embedded pinned standalone policy. It does not claim current
  external permission or revocation state.
- `completeness` is limited to `record-audit-v1`; rerun and delivery proof are not silently inferred
  from the bundle.

Audit retains one open archive handle while hashing and reading, rejects path aliases and special
entries, enforces fixed STORE-only ZIP metadata and byte ceilings, and never extracts or executes
bundle content.

## Recovery and retention

Do not delete the private ledger after publication. The signed bundle is a deliverable-only
recovery artifact; it is not a backup of drafts, work history, pending operations, or private keys.
An export failure leaves a prepared operation in `local status`. Correct the destination problem
and repeat the exact publish command. SFlow either completes the original operation or reports an
idempotency conflict; it never overwrites an existing artifact.

The implementation follows the corrected LOC identity graph: Candidate, review subject, approval,
release-content root, authorization receipt, manifest/bundle ID, archive digest, and delivery
receipt are distinct acyclic identities. Durable numeric compatibility is registered in the SFlow
migration registry; `schema: "loc.bundle.v1"` remains the stable wire-profile identifier.
