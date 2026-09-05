# Developer-local signed runner

The local signed runner is the middle option between an unsigned observation and an approved
enterprise CI verifier. It lets a lone developer prove that one exact configured quality command
produced one exact result on one exact repository candidate, and detect later tampering.

It is deliberately labelled `developer-local-signed`:

- the command runs in a separate SFlow child process;
- only shell-free `argv` commands already declared in the phase's `qualityCommands` are eligible;
- the command must declare `modelPolicy: never`;
- a reviewed plan binds the repository commit/tree, phase, command, Proof Subject, Candidate, and
  signing key before execution;
- the receipt contains hashes and counts, not command output, source paths, credentials, or Git
  identity;
- the receipt is signed with Ed25519 and written under the Work Item's GDP evidence directory;
- the private key is never committed, copied into a prompt, placed in an environment variable, or
  passed in process arguments.

This does **not** prove independence. The developer, editor, command, and signing process operate
under the same user account. Code executed by the command has that user's filesystem authority, so
the key is not a defence against a malicious local developer or malicious same-user test command.
The receipt therefore always says:

```text
authority: developer-local
gateEligible: false
consumedByLifecycle: false
```

It is accepted for local tamper detection, repeatable diagnostics, and demos. It is refused as an
independent review, an enterprise provider attestation, or a lifecycle-gate authority.

## Key protection

- macOS and Linux store the Ed25519 key in the repository's Git-common private sidecar with owner
  mode `0600`, inside an owner mode `0700` directory. It is not part of any commit or worktree.
- Windows protects the private key bytes with DPAPI `CurrentUser` before writing the sidecar. The
  unprotected key moves only through process memory and stdin to the OS protector.
- There is no plaintext Windows fallback. If DPAPI or PowerShell is unavailable, signer creation
  fails before a quality command runs.

Deleting the Git repository also deletes its local signer. That is expected: this is local evidence,
not an organisation trust root. A fresh laptop creates a new local key and therefore a new signer
identity.

## Use it

Run these commands from the governed repository.

1. Create or reuse a local signer:

   ```text
   singularity-flow delivery local-runner-create --signer developer-local --json
   ```

2. Confirm it is available and review its assurance ceiling:

   ```text
   singularity-flow delivery local-runner-status --signer developer-local --json
   ```

3. Create a plan for an existing phase quality command:

   ```text
   singularity-flow delivery local-runner-plan \
     --signer developer-local \
     --work-id WRK-123 \
     --phase implementation \
     --command module-tests \
     --proof-subject sha256:<64-lowercase-hex> \
     --candidate sha256:<64-lowercase-hex> \
     --json
   ```

   Save the complete JSON result in a repository-relative file. Review `data.plan`, particularly
   `repositoryHead`, `repositoryTree`, the complete shell-free `command`, `commandSha256`, and
   `signerKeySha256`.

4. Execute only that reviewed plan:

   ```text
   singularity-flow delivery local-runner-run \
     --plan local-runner-plan.json \
     --confirm-plan sha256:<plan-digest> \
     --json
   ```

   A native client that already holds the reviewed selector values can replay them without staging
   a plan file:

   ```text
   singularity-flow delivery local-runner-run \
     --signer developer-local \
     --work-id WRK-123 \
     --phase implementation \
     --command module-tests \
     --proof-subject sha256:<64-lowercase-hex> \
     --candidate sha256:<64-lowercase-hex> \
     --confirm-plan sha256:<plan-digest> \
     --json
   ```

   The engine reconstructs the plan from current repository state and requires its digest to equal
   the reviewed digest. File-based and direct selector forms are mutually exclusive.

   SFlow refuses the run if HEAD, the Git tree, configured command, or signing key changed after
   planning. A successful operation writes the signed receipt to:

   ```text
   singularity/work-items/<WORK-ID>/gdp/evidence/local-runner-attestation/<digest>.json
   ```

   A failed or timed-out quality command still produces a truthfully signed `failed` or `timed-out`
   receipt. It is never turned into a passing result.

5. Verify a retained receipt later:

   ```text
   singularity-flow delivery local-runner-verify \
     --attestation-file singularity/work-items/<WORK-ID>/gdp/evidence/local-runner-attestation/<digest>.json \
     --signer developer-local \
     --json
   ```

The verification succeeds only while the matching local signer is present. Sharing this receipt to
another laptop preserves its bytes but does not transfer trust; enterprise sharing requires an
approved public trust root and verifier integration.

## Use it from VS Code

Open **SGOS Command Center** and select **Local Runner…**, or run
**Singularity Flow: Developer-local Signed Runner…** from the Command Palette.

The native journey does not ask you to find or paste Candidate and Proof Subject hashes. It:

1. resolves the selected Story through `delivery local-runner-options`;
2. shows only configured shell-free quality commands whose `modelPolicy` is `never`;
3. creates or reuses the repository-local signer after a separate confirmation;
4. asks the engine to build an exact plan bound to the current commit, tree, Candidate, Proof
   Subject, configured command, and signer key;
5. displays those facts and the complete argv in a modal review;
6. replays the same selectors with the exact plan confirmation—without writing a temporary plan
   into the working tree—and opens the durable signed receipt on request.

The UI calls the same CLI plan and execution operations. It cannot supply a different command,
change the assurance label, make the receipt gate-eligible, or bypass stale-plan checks.

## Configured command example

The runner never accepts a command supplied on its command line. The repository configuration must
already contain a bounded command such as:

```yaml
phases:
  implementation:
    qualityCommands:
      - id: module-tests
        kind: test
        argv: [mvn, test]
        workingDirectory: .
        affectedRoots: [.]
        modelPolicy: never
        timeoutMs: 1200000
        result:
          adapter: junit-xml
          path: target/surefire-reports
          minimumDiscovered: 1
          minimumPassed: 1
```

Configuration refresh and normal review controls remain responsible for approving that command.
The local runner cannot edit or bypass them.
