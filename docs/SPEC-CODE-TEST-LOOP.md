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

## Make one governed pass

1. Author and approve Specification. Its stable, work-ID-qualified clauses must each have a row
   in the exact `Clause | Expected paths | Planned tests` table. The approved generation and hash
   are the Code and Testing input; an in-place change to an approved document is not an amendment.
2. In Code, implement the approved clauses, add repository-native executable tests, and publish
   through `/sf-code`. The kernel records a passing structured test receipt bound to that Code
   generation. If tests fail, repair Code before publication; a prose claim cannot override them.
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
