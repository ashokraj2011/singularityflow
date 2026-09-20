# Classic Delivery: review feedback and safe rework

Classic Delivery is the four-phase Story workflow **Intake → Code → Testing → Code checking**.
Code publishes application changes with a structured, passing repository-test receipt on the
Story branch. Testing reviews that Code receipt; Code checking verifies the approved delivery.
Neither downstream phase edits product source or treats a written claim as a test result.

## What can be enabled now

You can use Classic Delivery, its explicit reject-to-Code rework path, and the guarded local REV
pilot during an open unpublished Code generation. Optional REV feedback attachments can bind a
local text file to the active Story and phase. They are private staged evidence—not a committed
Story artifact, test receipt, or approval. The guarded pilot never invokes an autonomous model,
an arbitrary shell or Git authoring command, a project test command, or an external effect. It uses
bounded deterministic Git plumbing only to inventory and freeze exact Candidate bytes; Git is not
the authoring executor. Verify the exact build before use:

```bash
singularity-flow revision capabilities --json
singularity-flow revision activation --json
```

When `guardedEligible` is `true` and the required entries in `guardedOperations` are eligible, use
`/sf-revise` to preview and confirm an interval, make the bounded edit manually in the IDE, then use
the returned `revision capture` preview/confirmation and inspect the deterministic precheck card.
`activationProfile: disabled` and `eligible: false` describe the unavailable autonomous/full REV
profile; they do not disable the separately reported guarded local operations. A repository flag
cannot override a missing guarded capability, wrong phase, unsaved buffers, publication, or
recovery state. The pilot stops before ordinary phase publication, submission, approval, merge, or
deployment.

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

During Code, a developer may instead refine the current unpublished Candidate before publication:

```bash
singularity-flow revise --dry-run --feedback-stdin --saved-buffers-confirmed --json < feedback.txt
singularity-flow revise --feedback-stdin --saved-buffers-confirmed --confirm sha256:<PLAN> --json < feedback.txt
# Make and save only the bounded source/test edit in the IDE.
singularity-flow revision capture --preview --note "Applied reviewer correction" --saved-buffers-confirmed --json
singularity-flow revision capture --note "Applied reviewer correction" --saved-buffers-confirmed --plan sha256:<CAPTURE-PLAN> --confirm sha256:<CAPTURE-PLAN> --json
singularity-flow revision card --json
```

Copilot uses `/sf-revise`; `@sflow /revise` is read-only or prefills that skill. A green REV card
is not a test verdict and the selected head is not automatically published. Complete the ordinary
`/sf-code` test and publication flow separately against the same reviewed bytes.

If source or test files were already edited while Testing is **in progress**, ordinary Testing
publication must still refuse: its earlier Code receipt no longer describes those bytes. Keep the
edits and preview a governed early return instead:

```bash
singularity-flow reject testing --to implementation --repair --reason "Describe the test or environment repair"
```

Review the returned paths and exact confirmation digest, then rerun with `--confirm <sha256>`
(Copilot: `/sf-reject`). The reviewer-authorized change request preserves the dirty files but
reopens Code, where a new generation must pass structured tests and approval. A test-only repair
can reuse unchanged approved product source; it must not add a fake product edit. A transient
browser or environment failure with **no** source/test change should be re-observed in Testing,
not sent back to Code. Protected workflow configuration still uses its separate authority.

Classic Delivery currently **reviews** Code's committed tests in Testing; it does not claim an
independent Testing rerun receipt. Autonomous REV execution and selected-head publication remain
disabled until the specification's isolated execution/cleanup, durable quality receipts, exact
publication bridge, distinct Testing evidence, and release witness gates are satisfied.
