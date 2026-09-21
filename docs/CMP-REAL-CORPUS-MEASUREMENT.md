# CMP real-repository corpus measurement

Use this runner to compare the current CMP resource projection with explicitly reviewed expectations
over one or more real Git repositories. It is a privacy-safe evidence-collection boundary for CMP
P1, not a lifecycle gate, approval, rollout decision, or proof that the supplied review was
independent.

## Prepare the private reviewed manifest

Create a manifest outside every selected repository and retain it only in the approved private
evidence location:

```json
{
  "schema": "sflow-cmp-real-corpus-input/v2",
  "cases": [
    {
      "caseId": "payments-refactor",
      "repository": "/absolute/path/to/payments",
      "base": "0123456789abcdef0123456789abcdef01234567",
      "expected": {
        "changeSetSha256": "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "verdict": "incomplete",
        "resources": [
          {
            "pathBefore": "src/payment.js",
            "pathAfter": "src/payment.js",
            "operation": "modified",
            "classification": "material"
          }
        ]
      }
    }
  ]
}
```

The manifest is a closed, canonical operator input:

- `caseId` is a unique lower-kebab label. Cases are sorted by UTF-8 `caseId` byte order.
- `repository` is an absolute path that resolves to the exact local Git worktree root.
- `base` is the exact 40- or 64-character commit object ID reviewed for the case; branch names,
  ranges, and moving revisions are refused.
- `changeSetSha256` is the exact production repository-change-set digest collected during review
  with the runner's fixed `comprehension-observation` subject. It binds the reviewed base, current
  `HEAD`, index, worktree, untracked resources, modes, object identities, and current-content
  identities. It stays inside the private manifest and is never copied to the aggregate report.
- `resources` lists every reviewed current resource exactly once using its before path, after path,
  operation, and reviewed `material` or `nonmaterial` classification. Sort resources by UTF-8
  `pathBefore`, then `pathAfter`, then `operation`, treating `null` as empty.
- `verdict` is the reviewed expectation for the current observe-only coverage calculation:
  `complete`, `incomplete`, or `not-applicable`.

The v2 runner deliberately supplies no cause bindings, dispositions, or authority. Under the current
conservative fallback, a changed case normally observes `incomplete`, and an unchanged case observes
`not-applicable`. Recording `complete` as the reviewed expectation is still useful: it produces a
stable `falseIncomplete` mismatch until an evidence-bearing comparison is separately designed and
approved. The runner never manufactures cause authority to make that expectation pass.

## Run the reviewed comparison

From a Singularity Flow source or npm-package installation:

```bash
npm run benchmark:cmp:corpus -- \
  --manifest "/approved/private/cmp-corpus.json" \
  --samples 3
```

The fixed bounds are 1–16 distinct repositories, 1–64 cases, 1–20 samples per case, a 256 KiB
manifest, 5,000 resources per case, and 10,000 resources in total. The manifest must remain outside
the selected repositories and must be one ordinary, non-linked file. A repository/base selection
may appear only once.

Exit status is part of the contract:

- `0`: every exact subject, resource inventory, classification, and verdict matched;
- `1`: a valid run completed but one or more reviewed expectations mismatched; the content-free v2
  report is still written to standard output;
- `2`: the input or measurement boundary was invalid; no report is written.

## Stable mismatch counters

The `sflow-cmp-real-corpus/v2` report includes only aggregate counters:

- `subject`: cases whose exact change-set digest differed during any sample;
- `resourceInventory`, `missingExpectedResources`, and `unexpectedObservedResources`;
- `verdict`, with `falseComplete`, `falseIncomplete`, and `otherVerdict` separated;
- `classification`, with `falseMaterial` and `falseNonmaterial` separated;
- `cases`: the number of cases with at least one mismatch.

`falseComplete` means CMP observed `complete` when the reviewer expected another verdict.
`falseIncomplete` means CMP observed `incomplete` when the reviewer expected `complete`.
`falseMaterial` means the conservative projection marked a matched resource material when the
reviewed expectation was nonmaterial; `falseNonmaterial` is the reverse. Inventory mismatches stay
separate so a missing or unexpected resource cannot be hidden as a classification disagreement.

An expectation mismatch prints only the aggregate report plus the fixed
`CMP_REAL_CORPUS_MISMATCH` message. It never prints the case, repository, resource, commit, or digest
that differed.

## What it reads and emits

The runner uses the production repository-change-set, region-manifest, coverage, and experimental
record-preview implementations. It may read current changed-file bytes to calculate their exact
in-memory identities. It emits none of those bytes or identities.

The JSON object on standard output contains only:

- platform, architecture, and Node major version;
- repository, case, sample, region, classification, verdict, and mismatch counts;
- aggregate latency and CPU distributions;
- aggregate unresolved-reason and diagnostic counts;
- aggregate manifest, coverage, and record-preview byte distributions;
- explicit non-authoritative, no-lifecycle, and unauthenticated-review labels.

It excludes the manifest path, case IDs, repository/file paths, base commits, change-set/content
digests, source, cause statements, Work IDs, Git identities, prompts, and transcripts. It invokes no
  model, AST, network operation, cache writer, or lifecycle command. Git prompts, optional index
  refresh, lazy-object fetching, and replacement-object rewriting are disabled. Every sample is
  checked against the exact reviewed change-set digest, and the runner rechecks the private manifest
  plus every repository's `HEAD` and complete porcelain state before emitting output. Drift refuses
  or mismatches the run instead of producing a green mixed report.

The runner writes no report file. If stdout is retained, bind it externally to the private reviewed
manifest, reviewer decision, named machine class, and exact release subject. Do not add private
identities to the content-free report itself.

## Legacy unreviewed v1 mode

The original path-list form remains available for local performance collection:

```bash
npm run benchmark:cmp:corpus -- \
  --repository "/absolute/path/to/repository-one" \
  --repository "/absolute/path/to/repository-two" \
  --base HEAD~1 \
  --samples 3
```

It continues to emit `sflow-cmp-real-corpus/v1` with
`inputBinding: "operator-reviewed-out-of-band"`. It has no reviewed resource inventory, exact
expectation comparison, or mismatch exit and therefore cannot satisfy the reviewed-corpus exit gate.
`--manifest` cannot be combined with v1 `--repository` or `--base` options.

## Review and evidence boundary

A green v2 run proves only that the private expectations matched the selected local bytes without an
observed state change. The runner does not authenticate who reviewed them and reports
`reviewAuthentication: "not-performed"` and
`independentReview: "not-proven-by-runner"`.

CMP P1 still requires:

- independent review of the real-repository inventory, classifications, verdicts, and every finding
  disposition;
- supported physical-platform measurements on named machine classes;
- approved storage, retention, privacy, performance, and rollout decisions;
- an independently authorized decision before any new Story may default to `record` mode.

The synthetic, release-gated benchmark remains:

```bash
npm run benchmark:cmp
```

See the [CMP roadmap](CMP-ROADMAP.md) for the complete acceptance contract.
