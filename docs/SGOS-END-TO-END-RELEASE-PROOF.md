# SGOS end-to-end release proof

SGOS release promotion reuses the product's existing signed verification receipt. It does not have
a second signer, release branch, or success authority. Starting with platform-evidence schema v2,
each physical platform cell must bind the SGOS journeys and adversarial exercises required by
`SGOS-P0-004`.

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
  --signing-key runner.pem \
  --platform-evidence reviewed-darwin-node20.json \
  --identity darwin-node20-reviewer@example.com \
  --out darwin-node20.json
```

The generator validates the v2 evidence before running a model-free release suite, then validates
it again against the npm and VSIX bytes it actually produced. It signs the exact commit, tree,
package, VSIX, platform evidence, WEL benchmark, test summary, and verifier identity.

## Merge the six reviewed cells

```bash
npm run verification:receipt:merge -- \
  --receipt darwin-node20.json --receipt darwin-node22.json \
  --receipt linux-node20.json --receipt linux-node22.json \
  --receipt windows-node20.json --receipt windows-node22.json \
  --artifact-receipt linux-node22.json \
  --signing-key release.pem \
  --identity release-reviewer@example.com \
  --out verification-matrix-receipt.json
```

The merge refuses v1 evidence, missing cells, repeated cells, mixed commits, mixed trees, mixed
artifacts, invalid signatures, and any SGOS evidence gap. It retains every original signed cell
inside the new signed aggregate.

## Promote only the bound artifacts

```bash
npm run release -- \
  --verification-receipt verification-matrix-receipt.json \
  --verification-key release-public.pem
```

Release promotion revalidates the complete matrix and SGOS profile before work begins, after npm
packing, and after selecting the VSIX. A valid local or partial receipt is useful evidence but can
never authorize release.

## Completion boundary

The implementation at `main@7304c65c` supplies the strict schema, validators, generator, merger,
promotion refusal, template, and adversarial tests. `SGOS-P0-004` remains partial until independent
reviewers execute the unchanged procedure on all six physical platform/runtime cells and the
reviewed aggregate is retained for the final release commit.
