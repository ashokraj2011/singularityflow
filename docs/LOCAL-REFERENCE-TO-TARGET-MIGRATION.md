# Reference-to-target migration before the target repository exists

Use this guide when existing code is a **read-only reference** for a new implementation, but the
delivery repository has not been provisioned yet. A typical example is reading a Java rule-engine
API and producing a new PySpark batch rule engine without changing the Java repository.

This guide is about code or platform migration. It is not about migrating SFlow record schemas.

## Choose the correct path

| Situation | Supported path |
| --- | --- |
| The target repository and its application branch exist | Start a normal `reference-driven-build` Story in the target repository. |
| Target provisioning, access, or its remote is still pending | Use Local mode to create a private, signed staging deliverable. |
| A local target checkout exists but has no approved remote authority | Continue with Local mode. A normal Story requires a readable target remote and advertised application branch. |
| The target becomes available after Local mode work | Audit the local bundle, start a normal target Story with the same reference pin, then deliberately bring the reviewed output into its implementation generation. |

Do not map the reference repository as a writable Capability member. Do not create a Story branch,
commit, push, run hooks, install dependencies, or modify files in the reference repository.

## What Local mode guarantees

Local mode:

- copies explicitly selected, ordinary input files into private content-addressed storage;
- gives the author a separate output directory;
- freezes and verifies the exact output tree without invoking a model;
- records a standalone review of the exact Candidate;
- creates a deterministic Ed25519/DSSE-signed ZIP;
- supports create-only publication, safe retry, and offline audit; and
- works without a workspace, target repository, network, AST index, or World Model.

Local mode does **not**:

- fetch or pin a Git branch on the user's behalf;
- generate or migrate code;
- prove behavioral equivalence between the reference and the output;
- grant enterprise or repository approval;
- create or publish a target repository; or
- import a Local Story directly into a governed repository Story.

The author may use an IDE or Copilot to create files in the returned output directory. `/sf-local`
guides the deterministic Local-mode commands; it does not invoke a model or write the migrated code.

## Stage 1 — prepare reviewed local reference inputs

Use an existing, organisation-approved, clean reference checkout at one exact commit. Local mode
captures the bytes it is given; it does not safely fetch or materialize a remote reference branch.
If only a Git URL and branch are available, wait for the delivery target and use SFlow's native
reference materializer. Do not substitute a hand-written clone or checkout script: checkout filters,
submodules, symlinks, hooks, and unexpected Git entry types must be inspected before materialization.

The commands below record human-reviewed provenance from a checkout that has already been produced
through the organisation's approved Git process. Require the clean-tree command to print nothing
before continuing. This is not an authoritative SFlow reference pin: ignored files, checkout
configuration, and the non-atomic Local capture boundary mean that only later native Story
materialization can make that claim.

### macOS or Linux

```bash
export MIGRATION_ROOT="/absolute/private/path/spark-rule-migration"
export REFERENCE_CHECKOUT="/absolute/approved/path/java-rule-engine"

mkdir -p "$MIGRATION_ROOT"
git -C "$REFERENCE_CHECKOUT" status --short
git -C "$REFERENCE_CHECKOUT" rev-parse HEAD > "$MIGRATION_ROOT/reference-commit.txt"
git -C "$REFERENCE_CHECKOUT" rev-parse 'HEAD^{tree}' > "$MIGRATION_ROOT/reference-tree.txt"
```

### Windows PowerShell

```powershell
$MigrationRoot = Join-Path $env:LOCALAPPDATA 'SingularityFlow\migrations\spark-rule-migration'
$ReferenceCheckout = 'C:\approved\java-rule-engine'

New-Item -ItemType Directory -Force -Path $MigrationRoot | Out-Null
git -C $ReferenceCheckout status --short
git -C $ReferenceCheckout rev-parse HEAD |
  Set-Content -Encoding utf8 (Join-Path $MigrationRoot 'reference-commit.txt')
git -C $ReferenceCheckout rev-parse 'HEAD^{tree}' |
  Set-Content -Encoding utf8 (Join-Path $MigrationRoot 'reference-tree.txt')
```

Record the reviewed, credential-free remote URL and requested branch in a small
`reference-provenance.md` beside those files. SFlow preserves the bytes of that statement, but Local
mode does not independently prove that the human-written URL and branch labels describe the fetched
commit. The commit and tree IDs are human-reviewed provenance metadata; Local mode's input root
remains the exact identity of the bytes actually captured from the approved checkout.

Do not pass the reference checkout root as a Local-mode input: it contains a `.git` control entry.
Select only the source directories, build descriptors, schemas, fixtures, and documentation needed
for this migration.

## Stage 2 — create the private Local Story

Start with an explicit migration intent and only the bounded reference paths needed by the output.
Use the real data classification. A Local-mode bundle includes its captured input bytes, so a bundle
containing proprietary source must not be distributed outside the approved boundary.

```bash
singularity-flow local start spark-python-rule-engine \
  --intent "Create a new PySpark batch rule engine that reproduces the approved Java rule outcomes; do not modify or publish to the Java reference repository" \
  --input "$MIGRATION_ROOT/reference-provenance.md" \
  --input "$MIGRATION_ROOT/reference-commit.txt" \
  --input "$MIGRATION_ROOT/reference-tree.txt" \
  --input "$REFERENCE_CHECKOUT/pom.xml" \
  --input "$REFERENCE_CHECKOUT/src/main/java" \
  --input "$REFERENCE_CHECKOUT/src/test" \
  --classification restricted \
  --json
```

Copy the returned `storyId` and `outputDirectory`. Write all new PySpark files only beneath that
output directory. Keep the approved reference checkout read-only. Useful output structure for the
example is:

```text
pyproject.toml
src/spark_rule_engine/
tests/
fixtures/
MIGRATION-NOTES.md
```

The migration notes should state:

- reference remote, branch, commit, and tree;
- behavior copied and behavior intentionally excluded;
- Java-to-PySpark type and error mappings;
- batch partitioning, ordering, retry, and idempotency decisions;
- acceptance fixtures and expected results;
- performance assumptions and unverified claims; and
- target-repository onboarding and rollback steps still required.

Local mode will preserve these claims but will not decide whether they are correct.

Immediately after `local start`, repeat the clean-tree, `HEAD`, and `HEAD^{tree}` checks from Stage 1
and compare them with the recorded values. Stop if the checkout is dirty or either identity changed.
This narrows a human provenance race; it still does not turn the Local capture into an authoritative
Git-tree pin.

## Stage 3 — freeze, verify, review, and publish

Use the identifiers and digests returned by each command. Never reuse the example placeholders.

```bash
singularity-flow local status --story LOC-... --json

singularity-flow local freeze \
  --story LOC-... \
  --json

singularity-flow local verify \
  --story LOC-... \
  --candidate sha256:... \
  --json

singularity-flow local signer-create \
  --story LOC-... \
  --signer local-owner \
  --json

singularity-flow local trust-export \
  --story LOC-... \
  --signer local-owner \
  --out /absolute/approved/path/local-owner-public.pem \
  --json

singularity-flow local review \
  --story LOC-... \
  --candidate sha256:... \
  --signer local-owner \
  --json

singularity-flow local publish \
  --story LOC-... \
  --candidate sha256:... \
  --signer local-owner \
  --format loc.zip.store.v1 \
  --json
```

Omitting `--destination` publishes below the private default export root,
`~/.singularity-flow/local-mode/exports`. To use another approved location, first set the absolute
`SINGULARITY_FLOW_LOCAL_EXPORT_ROOT`, create that non-world-writable directory, and pass an existing
directory at or below it as `--destination`.

The private key remains in the Local Story's protected sidecar. Share only the bundle and exported
public key, and establish the signer identity through an independent approved channel.

## Stage 4 — when the target repository becomes available

The target Git provider must advertise an initial application branch before `bootstrap` can govern
it. After that branch exists:

```bash
singularity-flow bootstrap \
  https://github.example/office/spark-python-rule-engine.git \
  --capability spark-python-rule-engine \
  --name "Spark Python Rule Engine" \
  --kind delivery \
  --into /absolute/path/spark-python-rule-engine \
  --json
```

Retain the `root` and `branch` returned by `bootstrap`. The examples below call that returned branch
`<BOOTSTRAP-BRANCH>`; do not assume that it is named `main`.

Audit the local deliverable before using any of its bytes:

```bash
singularity-flow local audit \
  --bundle /absolute/path/LOC-....sflow-local.zip \
  --trust-key /absolute/path/local-owner-public.pem \
  --signer local-owner \
  --offline \
  --json
```

A successful audit proves archive integrity, exact input/output membership, and the standalone
signature. It does not replace product approval, tests, reference pinning, or target policy.

Start the authoritative Story from the target checkout and pin the reference again. The branch name
is provenance; the exact resolved commit recorded by Story start is authority for this Story.

```bash
cd /absolute/path/spark-python-rule-engine

singularity-flow start SPARK-RULES-1 \
  --from-branch <BOOTSTRAP-BRANCH> \
  --work-type reference-driven-build \
  --title "Create the PySpark batch rule engine" \
  --description "Reproduce the approved Java rule semantics in PySpark; do not change the Java API" \
  --acceptance-criteria "Approved fixtures produce equivalent rule outcomes" \
  --reference-repository java-rule-engine=https://github.example/office/java-rule-engine.git \
  --reference-branch java-rule-engine=release/2026-q3

singularity-flow story references list \
  --work-id SPARK-RULES-1 \
  --json

singularity-flow story references verify \
  --work-id SPARK-RULES-1 \
  --json
```

Compare the `commit` and `tree` reported for `java-rule-engine` with the values captured in
`reference-commit.txt` and `reference-tree.txt`. If either differs, do not use the staged output as
though it came from the Story's reference. Either recreate the Local Story from the newly pinned
reference, or restart the target Story with an organisation-approved immutable reference branch.
This check matters because an ordinary branch can advance between Local staging and Story start.

Complete specification and planning normally. For the first implementation generation, open the
governed boundary **before** introducing any staged application files:

```bash
singularity-flow prepare implementation
singularity-flow phase begin implementation --json
```

Only after both commands succeed, copy the approved output files into the Story worktree or re-author
them there from the audited bundle. Review the resulting diff, add acceptance-mapped target tests,
then continue with normal publication, submission, approval, and the terminal gate. The starter
policy blocks first-generation `--adopt-existing`, so copying files before `phase begin` is not a
supported shortcut.

Do not describe Local-mode verification as target test evidence. The target Story must run its own
configured tests against the exact target Candidate. Its normal approval groups must approve the
target artifacts and code.

## Copilot and VS Code

- Before a target exists, use `/sf-local`. It resolves the private Local Story and presents the
  deterministic commands; it does not search for a workspace or generate code.
- Local mode currently has no separate VS Code mutation panel. The Help Center explains and
  diagnoses the CLI flow.
- After the target exists, use `/sf-start` and select **Reference-driven build**. Enter each
  reference ID, clone URL, and branch separately.
- During implementation, `/sf-code` verifies the immutable reference checkout and keeps it
  read-only. Missing reference World Models never block ordinary bounded file access.
- VS Code **Lifecycle → Reference repositories** shows the pinned commit, detached-checkout health,
  and materialization actions for the target Story.

## Limits and common refusals

| Condition | Meaning and safe response |
| --- | --- |
| Target remote is absent | Expected before provisioning. Stay in Local mode; do not invent a URL or Capability mapping. |
| Target remote has no application branch | Create and push its approved initial branch, then run `bootstrap`. |
| `.git` or non-portable path rejected | Select bounded source subdirectories and files, not the checkout root. |
| Symlink, hard-linked file, or special file rejected | Do not bypass the check. Select ordinary files or create a reviewed regular-file export. |
| Input changed during capture | Stop writers, restore the reviewed clean checkout through the organisation's Git process, and restart Local Story capture. |
| Local resource limit reached | Narrow the reference scope. Current ceilings are 10,000 files, 512 MiB per file, and 2 GiB total content. |
| World Model or AST is unavailable | Local mode does not use either. Continue; authoring tools may use ordinary bounded file access. |
| Bundle already exists with different bytes | Choose a new approved destination; Local publication is create-only and never overwrites it. |
| Adoption digest keeps changing | Stop formatters, tests, and editors that write files; obtain and review one stable digest. |
| Target push is rejected | Preserve the governed commit and use the exact push-recovery action reported by SFlow. Do not create a replacement commit or push arbitrary HEAD. |

## Security checklist

- [ ] Reference URL contains no username, PAT, password, or other credential.
- [ ] Human provenance records the reviewed reference commit and tree before and after Local capture.
- [ ] No file in the reference checkout was modified, built, or executed.
- [ ] Only required ordinary source paths were captured.
- [ ] Local Story classification matches the most sensitive captured input.
- [ ] Bundle destination and recipients are approved for the captured source bytes.
- [ ] Public key was shared separately; private key was never copied.
- [ ] Target Story independently creates the authoritative reference pin when the target appears.
- [ ] Target Story's pinned commit and tree match the Local staging provenance.
- [ ] Target tests and approvals were produced again under target policy.
- [ ] Local standalone review was not represented as enterprise approval.

## Related guides

- [Reference repositories at Story intake](REFERENCE-REPOSITORIES.md)
- [Local signed deliverables](LOCAL-SIGNED-DELIVERABLES.md)
- [Fast onboarding and safe Git performance](FAST-ONBOARDING-AND-GIT-PERFORMANCE.md)
- [Ad hoc work and governed landing](../README-AD-HOC-WORK.md)
