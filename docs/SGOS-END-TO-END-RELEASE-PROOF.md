# SGOS end-to-end release proof

SGOS release promotion reuses the product's signed platform-matrix verification receipt. It does not
add an SGOS-specific signer, release branch, or success authority. The separately signed artifact
receipt identifies the one retained npm/VSIX pair exercised by that matrix. Starting with platform-
evidence schema v2, each physical platform cell must bind the SGOS journeys and adversarial exercises
required by `SGOS-P0-004`.

Historical schema-v1 platform evidence remains readable for audit. It cannot be used to generate,
merge, or promote a current release because it contains no SGOS end-to-end proof.

## Evidence required on every physical host and Node runtime

Start from [`examples/release-platform-evidence.template.json`](../examples/release-platform-evidence.template.json).
In addition to the installed-VSIX, staged-installer, package-isolation, authenticated-Playwright,
and Windows npm/npx checks, retain six distinct reviewed evidence receipts:

| Field | What the retained evidence must prove |
|---|---|
| `softwareConversionJourney` | Confirmed intent reaches verified publication through the exact retained Candidate and can be inspected from fresh authority. |
| `hypothesisAnalysisJourney` | The analysis journey preserves confirmed clauses, bounded execution, verification, and terminal evidence without allowing an Agent to mint authority. |
| `interruptionRecovery` | Process interruption, restart, and publication recovery settle to one exact stable state without a late success or different commit. |
| `counterfeitAuthorityRefusal` | Counterfeit, revoked, superseded, stale, reordered, or partially copied authority is refused. |
| `crossMachineAuthorityRoundTrip` | Approved Pack/Authority state transfers to a fresh machine through the reviewed transport and reconstructs the same active authority. |
| `performanceBudget` | Both journeys and their recovery operations meet a separately reviewed budget profile. |

Each entry contains only `outcome: passed` and a SHA-256 reference to externally retained evidence.
`performanceBudget` also binds `budgetProfileSha256`. The six evidence digests must be distinct.
Paths, logs, commands, host names, URLs, prompts, source, and credentials are not accepted by the
schema or runtime validator.

## Generate one signed platform receipt

Run this from a clean checkout of the exact release commit on each of macOS, Linux, and Windows,
under both supported Node 20 and Node 22 runtimes:

```bash
npm run verification:receipt -- \
  --artifact-receipt /retained/release-candidate/RELEASE-ARTIFACT-RECEIPT.json \
  --artifact-key /trusted/release-artifact-builder-public.pem \
  --package /retained/release-candidate/singularity-flow-0.9.0.tgz \
  --vsix /retained/release-candidate/singularity-flow-vscode-0.9.0.vsix \
  --signing-key /secure/platform-runner-private.pem \
  --platform-evidence /reviewed/reviewed-darwin-node20.json \
  --wel-corpus-review /reviewed/wel-corpus-review-darwin-node20.json \
  --wel-corpus-review-key /trusted/wel-corpus-reviewer-public.pem \
  --identity darwin-node20-reviewer@example.com \
  --out /retained/cells/darwin-node20.json
```

The generator validates the v2 evidence before running a model-free release suite, then validates
it again against the signed npm and VSIX bytes it consumed. It snapshots and re-verifies those exact
bytes and never rebuilds or substitutes the release pair. Broader source tests may create disposable
diagnostic packs or extension bundles, but they cannot enter the artifact subject. The receipt signs
the exact commit, tree, artifact authority, package, VSIX, platform evidence, WEL benchmark,
independently signed content-free WEL corpus review, test summary, and verifier identity. That review
does not upgrade WEL lifecycle authority. New cells use signed verification-receipt schema v7.

## Merge the six reviewed cells

```bash
npm run verification:receipt:merge -- \
  --receipt /retained/cells/darwin-node20.json \
  --receipt /retained/cells/darwin-node22.json \
  --receipt /retained/cells/linux-node20.json \
  --receipt /retained/cells/linux-node22.json \
  --receipt /retained/cells/win32-node20.json \
  --receipt /retained/cells/win32-node22.json \
  --artifact-receipt /retained/release-candidate/RELEASE-ARTIFACT-RECEIPT.json \
  --artifact-key /trusted/release-artifact-builder-public.pem \
  --wel-corpus-review-key /trusted/wel-corpus-reviewer-public.pem \
  --signing-key /secure/release-reviewer-private.pem \
  --identity release-reviewer@example.com \
  --out /retained/verification-matrix-receipt.json
```

The merge emits current signed matrix schema v8 and refuses historical cells, v1 platform evidence,
missing cells, repeated cells, mixed commits, mixed trees, mixed
artifacts, different artifact-receipt payloads, an untrusted builder, invalid signatures, and any
SGOS evidence gap. It retains every original signed cell inside the new signed aggregate. Historical
single v5/v6 and matrix v6/v7 receipts remain audit-readable but cannot be merged or promoted.

## Promote only the bound artifacts

```bash
npm run release -- \
  --artifact-receipt /retained/release-candidate/RELEASE-ARTIFACT-RECEIPT.json \
  --artifact-key /trusted/release-artifact-builder-public.pem \
  --package /retained/release-candidate/singularity-flow-0.9.0.tgz \
  --vsix /retained/release-candidate/singularity-flow-vscode-0.9.0.vsix \
  --verification-receipt /retained/verification-matrix-receipt.json \
  --verification-key /trusted/release-reviewer-public.pem \
  --wel-corpus-review-key /trusted/wel-corpus-reviewer-public.pem
```

Release promotion requires matrix schema v8 and revalidates the artifact, release-reviewer, and WEL
corpus-reviewer trust roots. Their Ed25519 SPKI SHA-256 fingerprints must be pairwise distinct. It
validates the complete matrix and SGOS profile, and the exact
retained artifact bytes before and after source validation. It byte-copies only the verified retained
pair into the promoted release; it does not repack or rebuild either artifact. A valid local or
partial receipt is useful evidence but can never authorize release. See the complete
[build-once artifact handoff](RELEASE-ARTIFACT-HANDOFF.md).

## Completion boundary

The implementation at `main@7304c65c` supplies the strict schema, validators, generator, merger,
promotion refusal, template, and adversarial tests. `SGOS-P0-004` remains partial until independent
reviewers execute the unchanged procedure on all six physical platform/runtime cells and the
reviewed aggregate is retained for the final release commit.
