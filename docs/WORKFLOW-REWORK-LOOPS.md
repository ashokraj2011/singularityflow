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

## Configure a loop

In VS Code, open **Singularity Flow → Configuration Center → Workflows & artifacts**, select a
Story workflow, and use **Rework loops**. Choose the review phase, an earlier repair phase, a
maximum number of attempts, and optionally an earlier phase whose new approved generation
resets the budget. Review the previewed backward edge before saving.

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
