# Classic Delivery: review feedback and safe rework

Classic Delivery is the four-phase Story workflow **Intake → Code → Testing → Code checking**.
Code publishes application changes with a structured, passing repository-test receipt on the
Story branch. Testing reviews that Code receipt; Code checking verifies the approved delivery.
Neither downstream phase edits product source or treats a written claim as a test result.

## What can be enabled now

You can use Classic Delivery and its explicit reject-to-Code rework path now. Optional REV
feedback attachments can bind a local text file to the active Story and phase. They are private,
staged feedback evidence—not an open Revision Loop, a committed Story artifact, a test receipt,
or approval. The installed REV executor is disabled. Verify the exact build before use:

```bash
singularity-flow revision capabilities --json
singularity-flow revision activation --json
```

When `activationProfile` is `disabled` or `eligible` is `false`, there is **no enable flag** for
executable REV. Do not create `.sflow/revision-pilot.json` to work around this result: an opt-in
alone cannot install the missing isolated executor, candidate-bound checks, publication bridge,
or release witnesses. `/sf-revision-attachments` remains available for evidence-only intake.

## Prepare Classic Delivery

In a repository already initialized with Singularity Flow, inspect the workflow first:

```bash
singularity-flow workflow list
singularity-flow workflow simulate classic-delivery
```

Newly initialized repositories include the packaged workflow. If an older repository lacks it,
preview `singularity-flow workflow install classic-delivery --dry-run`, then run
`singularity-flow workflow install classic-delivery` and review/publish the resulting protected
configuration through the normal configuration-review path **before** starting the Story. The
repository must also have an approved structured test adapter for Code publication. Workflow
installation does not silently commit configuration or change a Story already in progress.
If Classic Delivery is already installed, inspect `singularity-flow workflow diff classic-delivery`;
use `workflow install classic-delivery --replace` only after reviewing local customizations,
because replacement can overwrite its workflow definition and templates. Publish that change
through the same configuration-review path.

Start a new Story with `--work-type classic-delivery` and an explicitly selected base branch:

```bash
singularity-flow start DEMO-1 --from-branch main --work-type classic-delivery
```

In Copilot, use `/sf-start` and explicitly select **Classic delivery**. Existing Stories keep
their pinned workflow; installing an updated template does not rewrite a running Story.

## Use feedback without bypassing the lifecycle

1. In Code, implement and test the requested behavior through `/sf-code`. Code publication runs
   the approved structured test command and commits its normalized receipt. Review the actual
   result before submitting and approving.
2. If a reviewer has a local `.md`, `.txt`, `.json`, `.csv`, or `.tsv` feedback file, use
   `/sf-revision-attachments` to preview and explicitly register it against the active Story
   phase. For shell use, first run `singularity-flow revision attachments capabilities --json`;
   then preview and register with the **same** file and feedback bytes:

   ```bash
   singularity-flow revision attachments preview --file /path/to/review.md --feedback-stdin --json < /path/to/feedback.txt
   singularity-flow revision attachments register --file /path/to/review.md --feedback-stdin --confirm sha256:<PREVIEW-PLAN> --json < /path/to/feedback.txt
   ```

   Registration does not run a model, change code, submit, approve, or publish. If durable
   reviewer evidence must travel with the Story, use the normal governed Story-document path;
   private REV attachment storage is not a substitute.
3. When Testing or Code checking is awaiting approval and the reviewer finds a defect, use
   `/sf-reject` and select **Code** (`implementation`) as the target. Shell example:

   ```bash
   singularity-flow reject testing --work-id DEMO-1 --fetch --to implementation --reason "AC-002 fails for an empty input"
   ```

   The configured `rejectTo` policy must permit the target. If the Story is already completed,
   use the governed `reopen` path instead. Neither action silently edits or publishes source.
4. Resume the new Code generation, repair the source and tests, publish a new passing receipt,
   and repeat the normal submission, approval, Testing, and Code-checking gates. Do not treat
   the earlier Code receipt as proof for the changed generation.

Classic Delivery currently **reviews** Code's committed tests in Testing; it does not claim an
independent Testing rerun receipt. Full REV pilot activation would additionally require the
specification's candidate/head transaction, isolated execution and cleanup proof, Code-check
result before candidate acceptance, distinct Testing evidence, and its release witness gate.
