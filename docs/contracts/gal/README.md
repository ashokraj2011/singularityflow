# Git Access Layer acceptance evidence

`acceptance-matrix.json` is the machine-checked traceability catalog for the 44 acceptance cases in
`SPEC-git-access-layer (1).md` (source SHA-256 is recorded in the catalog).

The catalog intentionally claims **traceability only**:

- `evidence` identifies the repository test files that own code-local behavior;
- `external` identifies evidence that cannot honestly be produced by a single macOS checkout, such
  as physical Windows process cleanup, office proxy/credential behavior, provider hooks, installed
  VSIX behavior, and the supported Node/OS matrix;
- a listed test file does not mean that the external leg passed; and
- neither this catalog nor a local matrix cell grants release approval.

Validate the catalog and its matrix integration with:

```sh
npm run test:gal:acceptance
```

Run one source-bound local qualification cell with:

```sh
npm run test:platform:gal
```

The local cell always reports `releaseQualified: false`. Release qualification requires all
external evidence named in the catalog, no skipped required leg, an installed package/VSIX run, and
independent source/artifact review.
