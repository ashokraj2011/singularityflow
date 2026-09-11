# Build-once release artifact handoff

Singularity Flow releases one npm tarball and one VSIX. They are built once, signed once, exercised
unchanged by every physical platform cell, and copied unchanged into `dist/` at promotion. Source
verification on a cell or promotion host can create disposable diagnostic npm packs or extension
bundles, but those outputs are never selected as release artifacts and cannot replace the signed
pair.

This separation prevents a clean checkout from concealing host-dependent package bytes. Git can
report a checkout as clean while line endings, readable modes, ignored files, npm versions, or a
compressor differ. The canonical builder therefore materializes npm inputs from exact `HEAD` Git
blobs and `100644`/`100755` modes, refuses links and non-portable paths, and invokes the exact npm
version in `toolchains/npm-pack/package-lock.json`. The VSIX is built in a detached exact worktree
through its own tracked-input and locked-VSCE boundary.

## 1. Build and sign the artifact pair once

Keep the artifact-builder Ed25519 private key outside the repository, owned by the current user with
mode `0600` on POSIX hosts or a protected, non-inherited, current-user-only ACL on Windows, and run
from the clean release commit:

The installed CLI and extension continue to support Node.js 20 or newer. Canonical artifact
generation has a narrower toolchain baseline: use Node.js 20.18.1 through 20.x, or Node.js 22.9.0
or newer. The supported-platform receipt matrix itself remains the declared Node 20/22 pair.

```bash
npm ci
npm run release:artifacts -- \
  --signing-key /secure/release-artifact-builder-private.pem \
  --identity artifact-builder@example.com \
  --out-dir /retained/release-candidate
```

The output directory contains:

- `singularity-flow-<version>.tgz`;
- `singularity-flow-vscode-<version>.vsix`;
- `RELEASE-ARTIFACT-RECEIPT.json`.

The signed receipt binds the exact source commit/tree, artifact names/sizes/digests, canonical npm
entry-manifest digest, source epoch, Node/npm/zlib versions, the production dependency lock, and
both packaging-toolchain lock digests. Every production dependency and its locked transitive closure
is embedded in the tarball; platform smoke installation runs offline. Preserve these three files
together. Re-running the builder is a new build, not a substitute for missing retained bytes.

## 2. Exercise those exact bytes on every platform cell

From a clean checkout of the exact release commit, each macOS/Linux/Windows and Node 20/22 cell
receives the retained files and the explicitly trusted artifact-builder public key:

```bash
npm ci
npm run verification:receipt -- \
  --artifact-receipt /retained/release-candidate/RELEASE-ARTIFACT-RECEIPT.json \
  --artifact-key /trusted/release-artifact-builder-public.pem \
  --package /retained/release-candidate/singularity-flow-0.9.0.tgz \
  --vsix /retained/release-candidate/singularity-flow-vscode-0.9.0.vsix \
  --platform-evidence /reviewed/platform-evidence.json \
  --signing-key /secure/platform-runner-private.pem \
  --identity reviewer@example.com \
  --out /retained/cells/darwin-node22.json
```

The command verifies the artifact receipt, its explicitly trusted signer, and both files before and
after testing. Before any artifact is executed, descriptor-verified bytes are copied into a new
per-invocation snapshot (`0700` where POSIX modes apply); npm installs only that snapshot tarball,
and the VSIX engine smoke extracts only that snapshot VSIX. The artifact-consumer portion of the
POC gate omits extension packaging, source-bundle building, and npm package inventory. The broader
source test suite may create
throwaway diagnostic packs or bundles; they do not enter the receipt's artifact subject. The cell
receipt records the artifact-receipt payload and signer digest and never rebuilds the signed pair.

Physical platform evidence remains external. Repository tests can validate signatures, subjects,
hashes, schemas, and refusal behavior; they cannot prove real host execution, approved builder-key
custody, immutable artifact-store retention, office-network behavior, installed VS Code activation,
or independent review.

Every `--artifact-key` and `--verification-key` is an operator-selected trust root, not repository
configuration. Keep these public keys outside the checkout as bounded ordinary non-symlink files.
Apply the same external, current-user-only custody rule used for the builder key to every platform
runner and release-reviewer private signing key.
Receipt outputs are published through an atomic no-clobber claim: choose a fresh output name, and
archive or deliberately remove an older receipt before retrying generation.

## 3. Merge the six cells

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
  --signing-key /secure/release-reviewer-private.pem \
  --identity release-reviewer@example.com \
  --out /retained/verification-matrix-receipt.json
```

Merge refuses mixed source subjects, artifact digests, artifact receipt references, missing cells,
or an untrusted builder. Historical v5 single-cell and v6 matrix receipts remain readable, but all
new generation uses the build-once v6/v7 contracts and cannot be mixed with historical cells.

## 4. Promote without rebuilding

```bash
npm run release -- \
  --artifact-receipt /retained/release-candidate/RELEASE-ARTIFACT-RECEIPT.json \
  --artifact-key /trusted/release-artifact-builder-public.pem \
  --package /retained/release-candidate/singularity-flow-0.9.0.tgz \
  --vsix /retained/release-candidate/singularity-flow-vscode-0.9.0.vsix \
  --verification-receipt /retained/verification-matrix-receipt.json \
  --verification-key /trusted/release-reviewer-public.pem
```

Promotion verifies both trust roots and exact bytes, then copies the artifact files only from the
descriptor-verified private snapshot into `dist/`. It also writes `SHA256SUMS`, `RELEASE.json`,
`RELEASE-CHANNEL.json`, `ARTIFACT-RECEIPT.json`, and `VERIFICATION-RECEIPT.json`. Source checks and
the bundle-budget gate can create disposable diagnostic outputs, but there is no fallback artifact
pack, release-VSIX build, download, or same-version substitution. The complete candidate is flushed
before a durable same-parent journal is published; if the process or host stops between directory
renames, the next promotion restores the prior release or retains the complete promoted candidate
before continuing.

`npm run release:dry -- <the same authority and artifact arguments>` performs the same admission and
verification without publishing a new candidate. It still begins by reconciling any reserved
recovery state left by an interrupted earlier `dist/` promotion; absent that state, it writes nothing
to `dist/`.
