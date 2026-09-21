# Specification → Code → Playwright testing review

The packaged `spec-code-test-loop` Story workflow keeps four approved checkpoints:

`Specification → Code → Playwright testing review → Spec, code and test checking`

This is a **guided, bounded rework workflow**, not an autonomous spec/code/test executor. A
Playwright MCP browser observation records what the host actually displayed; it is not a passing
repository test result. Code publication still requires the normal structured, executable
repository-test receipt. Neither an MCP screenshot nor a written testing report can substitute
for that receipt or for human approval.

## Set up a repository

The workflow is included in a fresh initialized repository. For an older repository, preview its
configuration changes with `singularity-flow workflow install spec-code-test-loop --dry-run`
(Copilot: `/sf-workflows add spec-code-test-loop --dry-run`). Review and install it through the
repository's approved `sflow/config` path, then refresh approved configuration before starting a
new Story. Existing Stories retain their pinned workflow snapshot.

Configure an approved repository-native structured test command for Code. Browser testing also
requires an approved Playwright MCP host, an authorized target origin, and a current smoke receipt.
Use `singularity-flow mcp doctor --server playwright --json` (Copilot: `/sf-mcp doctor`) to inspect
readiness. The host owns transport, credentials, and permission prompts. SFlow does not provide an
isolated runner or attest network denial for arbitrary project tests.

Start with an explicit base branch:

```bash
singularity-flow start DEMO-101 --from-branch main --work-type spec-code-test-loop
```

Copilot equivalent: `/sf-start`, then choose **Spec → code → Playwright review**.

## Inspect the optional browser-revision foundation

The workflow can use the BRL foundation while Code is still unpublished, but selecting this work
type does not install or authorize a browser runner. Inspect the compiled boundary before relying
on it:

The current foundation can project registered assertion outcomes only. It refuses visual-baseline
activation and visual comparison claims until a registered pixel comparator and governed baseline
store are installed; screenshots remain review artifacts, not deterministic visual proof.

```bash
singularity-flow revision checks capabilities --json
```

Copilot: `/sf-revision-checks capabilities`

Chat participant read: `@sflow /revision-checks`

With a ready Story session and a current retained REV Candidate, planning is read-only and selects
that Candidate from governed state; callers cannot supply a command, URL, environment, phase, or
Candidate:

```bash
singularity-flow revision checks plan --json
```

Copilot: `/sf-revision-checks plan`

Inspect an existing run without changing it:

```bash
singularity-flow revision checks status [<RUN-ID>] --json
singularity-flow revision checks result <RUN-ID> --json
```

Copilot: `/sf-revision-checks status [<RUN-ID>]` or
`/sf-revision-checks result <RUN-ID>`.

The skill never starts a check. If the user separately authorizes one exact current plan, the
Shell-only mutation is:

```bash
singularity-flow revision checks run \
  --plan sha256:<PLAN> \
  --confirm sha256:<PLAN> \
  --json
```

Both digests must be identical and complete. The command must refuse before execution when the
installed build cannot prove its fixed same-process runner and bounded cleanup. Do not replace it
with Playwright MCP, `npm test`, an arbitrary shell command, a model tool, or a handwritten result.
Even a completed bounded browser observation establishes neither a passing repository test nor
criterion satisfaction, Testing/Verification, publication, approval, merge, deployment, or
release eligibility. The normal Code structured-test receipt and later Playwright review remain
mandatory.

## Make one governed pass

1. Author and approve Specification. Its stable, work-ID-qualified clauses must each have a row
   in the exact `Clause | Expected paths | Planned tests` table. The approved generation and hash
   are the Code and Testing input; an in-place change to an approved document is not an amendment.
2. In Code, implement the approved clauses, add repository-native executable tests, and publish
   through `/sf-code`. The kernel records a passing structured test receipt bound to that Code
   generation. Optional `/sf-revision-checks` evidence may be shown alongside the retained
   Candidate with its exact stale bindings and artifact provenance, but it grants no green or
   publication authority. If tests fail, repair Code before publication; a prose claim cannot
   override them.
3. In Playwright testing review, use the approved browser origin. Record this generation's
   host-observed navigation and snapshot with Playwright MCP, compare the observed behavior with
   each Specification clause, and cite the existing Code test receipt separately. Use `/sf-mcp`
   for host readiness and evidence operations; `/sf-phase` prepares and publishes the review.
4. In Spec, code and test checking, compare the exact approved generations, source/test evidence,
   browser observations, unplanned changes, and residual risk. Human approval remains separate.

## Repeat without losing document integrity

The Testing reviewer records a clause-specific finding and chooses its target:

- **Code or executable-test defect:** `/sf-reject` to `implementation`. SFlow records the change
  request, invalidates dependent approvals, and opens a new Code generation. Re-run the structured
  Code tests and Playwright review on the new code; old receipts remain in history but are stale
  for the new generation.
- **Source or test edit discovered while Testing is still in progress:** keep the edited bytes in
  the worktree; do not publish them as Testing output. Preview
  `singularity-flow reject testing --to implementation --repair --reason "<reason>"` (Copilot:
  `/sf-reject`). Review the exact changed paths and digest, then add the returned `--confirm` value
  to authorize the return. The edit becomes a candidate for a *new Code generation*, which must
  rerun structured tests and receive Code approval before new Playwright observations are valid.
  A test-only repair may reuse the prior approved product source only when its bytes are unchanged;
  no fake product-code edit is needed. Protected workflow or configuration changes still use
  their separate configuration authority.
- **Wrong or incomplete approved requirement:** prepare the proposed complete Specification in a
  separate Markdown file, then run
  `singularity-flow story intent-amendment propose --file <AMENDED-SPEC.md> --reason <TEXT> --source-phase <CURRENT-PHASE> --clause <CHANGED-CLAUSE-ID>`
  from the current Code or Testing phase. Repeat `--clause` for every changed clause; the proposal
  leaves the approved Specification untouched. An authorized product reviewer separately runs
  `singularity-flow story intent-amendment decide <AMD-ID> --decision approve --confirm <AMD-ID>`.
  Approval creates a new Specification generation, invalidates downstream approvals, and opens
  Code revalidation; the developer acknowledges the amendment before submission. Preserve old
  clause IDs where obligations are unchanged. Never edit the approved generation in place.
- **Environment or observation gap:** remain in `testing` for a new review generation. Do not
  classify an unavailable browser or stale smoke receipt as a product-code failure or a pass.

The Code rework budget is three governed attempts, resetting when a new Specification generation
is approved. Reaching the bound stops for a human decision; it does not silently waive evidence
or repeat forever. A fully self-executing loop would need a separately approved isolated runner,
candidate-bound test receipts, process/network-effect attestation, and policy for who may approve
intent changes. This workflow does not claim those capabilities.

To declare a similarly bounded return edge in a custom Story workflow, use the Workflows &
artifacts Designer or the `workflow create`/`workflow edit --loop` option documented in
[Bounded rework loops](WORKFLOW-REWORK-LOOPS.md). Custom loops use submitted-phase reviewer
rejection; they do not inherit this packaged workflow's special in-progress Testing repair route.
