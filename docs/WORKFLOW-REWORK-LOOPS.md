# Bounded rework loops in Story workflows

A Story workflow normally advances through its ordered phases. A **rework loop** lets a reviewer
return a submitted phase to an earlier phase when its evidence exposes a defect. This is a
reviewer-directed correction route, not an unattended agent that repeatedly changes code or
approves its own work.

For example, a workflow can advance through Specification → Code → Testing → Conformance and
allow a Testing reviewer to return to Code at most three times. A Code repair creates a new
generation; the affected downstream evidence and approvals must be produced again. If the
approved Specification changes, it needs a governed intent amendment and a new approved
generation, not an in-place edit.

## Return routes in the packaged workflows

In every packaged workflow, the reviewers of a step may reject it to any earlier step or to the
step itself; each phase's `approval.rejectTo` lists them in workflow order. A Code step can
therefore return the Story to the planning, specification, design or intake steps that produced
its inputs and own its planned claims. A verification, testing, convergence, release,
conformance, retest or closing review can return it to Code or to those earlier steps. Shared
phases such as `implementation` keep a short default in `phases:`; each packaged work type names
its own list in `phaseOverrides`. A step nobody reviews (`approval: none`, such as quick-fix's
Implement step and the first three POC Lite checkpoints) has no reviewer to reject it, so its
policy names only itself.

A wider return does not change who decides or what happens:

- The rejecting step's own approvers authorize the return, with a change-request reason. The
  target step's approvers do not.
- The target step and every step after it reopen. The target needs a fresh generation, and a
  later step keeps its approval only when nothing it decided over changed (rule E1, see
  `sflow explain rejection-and-rework`).

Repair budgets still bound the returns they cover. In `spec-code-test-loop`, a return from a
later step to Code counts against Code's three-attempt budget; a return to Specification uses no
attempt and starts a new count only once a new Specification generation exists. In
`poc-workflow`, a return from Publication review to validation or any step after intake counts
against the validation step's two-attempt budget, as does a return from a failed validation to
any step after intake; a return to intake starts a new count once a new intake generation exists.
Decisions in the scenario workflows still bound their automatic routes; a reviewer's rejection is
explicit human direction. The other packaged workflows declare no budget, so, as before, their
returns are bounded by human review alone.

### Existing Stories keep their return routes

A Story keeps the workflow it started with. Story start captures an immutable workflow snapshot
(see [Workflow Adapters and Story Snapshots](WFA-WORKFLOW-SNAPSHOTS.md)), and each phase's
approval policy, including its `rejectTo` list, is pinned in the Story's state. Refreshing the
repository's packaged configuration with `singularity-flow workspace refresh-configuration`
changes only Stories started afterwards; `singularity-flow story workflow drift --work-id <ID>`
shows how a running Story differs. The snapshot cannot yet be amended in place
(`WFA_AMENDMENT_UNSUPPORTED`), so a Story started before this change keeps its old targets until it
finishes. For a completed Story whose final gate assigns a blocking finding to a step outside those
targets, `singularity-flow reopen <WORK-ID> --to <PHASE> --gate-recovery` remains the route.

## Configure a loop

In VS Code, open **Workflow Studio**, open a Story workflow, select the review step and, under
**Sign-off**, use **Add a send-back rule**. Choose the earlier repair step, the maximum number of
attempts, and optionally an earlier step whose new approved generation resets the budget
(**Count again after**). Rules into the same step share one budget. **Check changes** validates the
backward edges before you publish.

From a shell, the corresponding workflow-authoring option is:

```bash
singularity-flow workflow edit my-workflow \
  --loop testing:implementation:3:specification \
  --propose
```

Here `testing` is the review phase, `implementation` is the earlier repair phase, `3` is the
bounded attempt count, and `specification` is the optional reset phase. The reset phase must be
strictly earlier than the repair phase; otherwise a return to the repair phase could reset its
own attempt count. Repeat `--loop` to define
more than one return edge. On `workflow edit`, the supplied `--loop` values replace the whole
loop set; include any existing loops you want to retain. To remove all configured loops from a workflow, use
`singularity-flow workflow edit my-workflow --clear-loops --propose` and review the resulting
configuration change. Phase IDs must already belong to that Story workflow; a loop cannot create
a phase. The target must precede the review phase.

For a lead-governed repository, workflow edits are review proposals against `sflow/config`.
Merge the approved proposal and run `singularity-flow workspace refresh-configuration` so **new**
Stories can select it. Existing Stories keep the workflow resolution pinned when they started.
For a self-governed local repository, follow its local `sflow/config` review path. Do not edit
protected `singularity/workflow.yml` from an active Story branch.

## Use a loop during a Story

After the review phase has been generated, published, and submitted, the authorized reviewer can
reject it to a configured earlier phase with a concrete reason. Copilot's `/sf-reject` guides
this decision; the shell equivalent is `singularity-flow reject <REVIEW-PHASE> --to
<REPAIR-PHASE> --reason "<finding>"` (check the exact command shown by the current build).
The lifecycle records the finding, reopens the repair phase, and invalidates dependent downstream
approvals. The repair phase must publish its own new generation and satisfy its normal structured
test gate before testing/review is repeated. When the attempt limit is exhausted, the workflow
stops for a new human decision rather than silently retrying or waiving evidence.

The special in-progress Testing → Code repair route in the packaged `spec-code-test-loop` and
`classic-delivery` workflows is separate from ordinary reviewer rejection. A newly authored loop
does not automatically authorize code edits during an in-progress Testing phase. It also does not
grant an isolated runner, browser access, protected configuration edits, or self-approval.

## Example and inspection

The packaged `spec-code-test-loop` is a working example; see
[Specification → Code → Playwright testing review](SPEC-CODE-TEST-LOOP.md). Inspect a proposed or
approved custom workflow with `singularity-flow workflow simulate my-workflow` and
`singularity-flow workflow validate my-workflow --json` before starting a Story.
