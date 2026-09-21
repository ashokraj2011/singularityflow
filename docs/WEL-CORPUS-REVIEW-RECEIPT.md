# WEL real-corpus independent review receipt

The WEL real-corpus runner emits a bounded aggregate that excludes repository paths, source and
report bytes, test names, clause identifiers, content digests, identities, prompts, and transcripts.
That local aggregate deliberately has no lifecycle or release authority. A
`singularity-flow-wel-real-corpus-review-receipt` v1 records that an independently trusted reviewer
accepted one exact aggregate produced by one exact release source and runtime.

## Authority boundary

The receipt authenticates only the independent review claim. It does not authenticate test
execution, approve a Story, satisfy an SGOS task, enable WEL enforcement, or publish Git authority.
Both the signed receipt and its embedded measurement must retain:

- `lifecycleAuthority: "none-observe-only"`;
- `measurement.authority: "none"`;
- `measurement.lifecycleGate: false`;
- `measurement.authoritative: false`;
- `measurement.releaseEligible: false`.

The review signing key and its trusted public key must be controlled outside the Candidate and
repository. An embedded public key is not a trust root. Release verification requires the public key
through a separate operator input and refuses a receipt signed by any other key.

## Produce one reviewed runtime receipt

An independent reviewer first approves the private manifest through the organisation's review
process and assigns an opaque reference containing no path, identity, or corpus content. On the
reviewed host and exact clean release checkout, run the command below. The reference must be either a canonical
lowercase `review:<uuid>` or a content-addressed `sha256:<64-lowercase-hex>` value; descriptive IDs,
paths, URLs, and identities are refused.

```text
npm run evidence:wel:corpus-review -- \
  --manifest /private/reviewed/wel-corpus.json \
  --samples 3 \
  --signing-key /private/keys/wel-corpus-reviewer-private.pem \
  --identity independent-reviewer@example.invalid \
  --review-reference review:123e4567-e89b-42d3-a456-426614174000 \
  --out /private/evidence/wel-corpus-review-darwin-node-22.json
```

The command:

1. requires a clean Git checkout and records its exact commit and tree;
2. runs `scripts/wel-corpus-measurement.mjs` without executing corpus tests or using network/model
   services;
3. refuses mismatches, false-exact or false-inconclusive results, repository drift, content-bearing
   output, and incomplete measurements;
4. binds the exact canonical measurement digest, runner entrypoint/profile, platform, architecture,
   and full Node version;
5. writes one signed receipt atomically without overwriting existing evidence.

The private manifest and corpus paths are never copied into the receipt. Retain the manifest review
record and raw reports in the separately governed private evidence store identified by the opaque
review reference.

## Bind release verification

Each physical platform/Node verification cell consumes the receipt for that exact source and runtime:

```text
npm run verification:receipt -- \
  --wel-corpus-review /private/evidence/wel-corpus-review-darwin-node-22.json \
  --wel-corpus-review-key /trusted/wel-corpus-reviewer-public.pem \
  ...the existing artifact, platform-evidence, verifier-key, package, and VSIX options...
```

Matrix merge and final promotion both require the same independently obtained public trust root:

```text
npm run verification:receipt:merge -- \
  --wel-corpus-review-key /trusted/wel-corpus-reviewer-public.pem \
  ...six signed platform receipts and existing artifact/reviewer options...

npm run release -- \
  --wel-corpus-review-key /trusted/wel-corpus-reviewer-public.pem \
  ...the signed matrix, artifact, package, and VSIX options...
```

The artifact-builder, release-verifier, and WEL-reviewer Ed25519 keys are independent roles. Their
SPKI SHA-256 fingerprints must be pairwise distinct; receipt generation, merge, and promotion refuse
a key reused under two roles.

Current single-host receipt schema v7 and matrix schema v8 retain the complete signed content-free
receipt plus its canonical digest in each cell. Earlier signed versions remain verifiable for audit,
but cannot be merged into a new matrix or authorize promotion.
Merge and promotion replay its independent signature, source, platform, architecture, runtime,
measurement digest, closed aggregate shape, and observe-only authority ceiling. A missing receipt,
wrong trust root, cross-runtime substitution, changed aggregate, or re-signed content-bearing shape
fails closed.

This evidence closes only the durable handoff gap for independently reviewed corpus measurements.
CAB-R2 authenticated execution, external trust-root governance, physical host operation, and all
Story lifecycle authority remain separate prerequisites.
