# Completing a workflow task

The current phase's authoring task completes when its publication is observed. A turn may also end
at an exact blocker handed to its required owner. Reading inputs, scaffolding a template and passing diagnostic
tests do not complete authoring. Independent source review finishes when its report is retained;
an honest correction-required report is a completed review, rather than approval.

This contract follows the registered authoring capability and the pinned phase policy. Planning,
implementation, verification, release, imported and copied phases, user-defined `/sf-call` agents
and future custom phase names use the same mechanism. No extra workflow YAML is required.

`phase enter --for-agent` returns `taskCompletion` and `taskResume`. A stable operation ID binds
the Story identity, repository identity, phase, generation and author/reviewer role. It survives a
new chat; author and independent reviewer tasks have different IDs. Current pins and predecessor
artifacts form the input revision. A changed revision invalidates affected checkpoints while spent
budgets remain spent. A blocked clarification or admission keeps its human route.

The shared resolver serves phase entry, prepublish, source review, session current/attach and
next-step guidance. It chooses work from current kernel observations, not saved commands or model
claims. A prepared artifact, diagnostic test pass, ready check or stored `complete` state cannot
establish publication or retained review. Interrupted publication/retention first receives its
inspection route; an unknown outcome is never replayed blindly. After an interrupted author publication,
the exact read-only `phase draft-check` records the current findings so entry can resume without a
recovery/entry cycle. Fresh source-review context already checks retained state and the report;
it resumes from that observation. Pending publication and real owner blockers keep their recovery
routes, and final prepublish/retention checks still run. Approval-only steps receive no
invented author task, and submitted phases retain their lifecycle handoff.

Progress is versioned, content-hashed metadata under the Git common directory's
`singularity-flow/workflow-tasks/`. Short locks protect updates. At meaningful existing Story writes,
portable progress is batched into `workflow.json` and travels through the existing Story/ledger
publication. No remote request, commit or push is added for individual file reads or entry checks.
No prompts, document/image bytes, native paths, arbitrary commands or human consent enter portable
records. Published artifacts, retained reviews, tests and approvals remain the evidence authorities.

For an unfinished task handoff, use the entry's exact `taskResume.handoff` route:

```sh
singularity-flow appeal task-checkpoint --work-id <WORK-ID> --phase <phase> --role author --json
```

This explicit operation publishes only progress at `workflow-tasks/<story-hash>/<task-id>.json`
on the configured state branch. It preserves the dirty source tree and index; it cannot transfer
uncommitted drafts or local attachments. Disabled shared publication is reported as local-only.
State writes use exact path preconditions, so a competing checkpoint cannot silently replace
another one's spent budget. Attach imports at most two exact task blobs from the selected state
snapshot, with no branch or history scan. Normal reads thereafter reuse the local imported record.
Receiving users must explicitly transfer missing drafts and re-upload required local documents;
fresh phase entry issues the correct paths and independently checks publication/review bindings.

When a host supports `agentStop`, a premature normal end of a full authoring/review task receives
one atomic continuation for that turn. Its task-scoped budget survives chat restarts, using exclusive
bounded claims rather than resetting at each prompt. It reuses the admitted context and already-read inputs.
It cannot reset repair budgets, start another model or phase, or approve, submit, fabricate evidence
or decide for a person. Genuine blockers, expired or changed bindings, pause, cancellation, an ended
decision and an already-used continuation end automatic follow-up. The existing draft and the
explicit owner route remain available. Explicit single-step and human-approval turns do not opt in.
Hosts without stop callbacks receive the same task and file-reader contract through CLI output.

A takeover carries spent repair counts. If the original machine's reservation journal is unavailable,
another automated reservation is refused; correcting the current owned draft and running fresh
checks remain available in the same phase. Local attachments never become missing-file substitutes
or automatic acceptance. A new chat reads the instructions it needs; another chat having read them
is not evidence that this model has those instructions.

Damaged task metadata has an explicit `appeal task-quarantine` preview and exact confirmation route.
Recovery preserves the damaged bytes in private quarantine, leaves source and evidence intact and
keeps all automation spent for that operation. It does not create a new retry budget. Real filesystem
access failures retain their native diagnostic and owner route. A failed progress import discloses
its error without undoing a successful Story attachment.
An unreadable shared checkpoint is preserved privately and disables automation without losing the
attached Story. Only known damaged metadata can be repaired under exact state-path preconditions;
a checkpoint from an unsupported newer schema retains its update-client route.

## File reads

One native-reader classifier covers `view`, `read`, `read_file`, `readfile`, `read_text_file`,
`get_file`, editor view operations and namespaced variants. Large reads return bounded
`readRanges` and, when the request's native parameter format is known, exact `readRequests`.
Invalid line ranges return the actual file bounds and corrected requests. Original paths and native
tool names are preserved; offset/head/tail conventions are left to the native reader rather than
guessed. Complete all required ranges and continue the current task after a recoverable read limit.
A native failure at a smaller host limit halves the current window. Numeric offset/limit requests
split in their existing native units without assuming whether the original offset starts at zero
or one. Unsplittable content retains its original diagnostic and owner route.

An unsplittable native failure disables automatic completion for that attempt, rather than forcing
another read without a smaller plan. A staging-path correction continues only when every correction
explicitly targets a read from the attempted path to its CLI-issued path; write denials stay denials.
Issued-path corrections remain exact hints, not grants. Real missing-file, sharing and permission
errors retain their native code, attempted path and read-only recovery/owner route. No input is
searched for, recreated or overwritten, and unchanged access is not retried automatically. Images,
binary files, special files and unsplittable single lines keep their native reader behavior.

Stop checks reuse the current turn's native file stamps. They scan no branches or Git history,
spawn no Git process and reload no repository policy. Progress records can be local or explicitly
shared; published generations, retained reviews, evidence and human decisions remain the durable
sources of truth.
