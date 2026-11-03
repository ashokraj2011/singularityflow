# Completing a workflow task

The current phase's authoring task completes when its publication is observed. A turn may also end
at an exact blocker handed to its required owner. Reading inputs, scaffolding a template and passing diagnostic
tests do not complete authoring. Independent source review finishes when its report is retained;
an honest correction-required report is a completed review, rather than approval.

This contract follows the registered authoring capability and the pinned phase policy. Planning,
implementation, verification, release, imported and copied phases, user-defined `/sf-call` agents
and future custom phase names use the same mechanism. No extra workflow YAML is required.

`phase enter --for-agent` returns `taskCompletion`, including the target generation, current
checkpoint and exact next/recovery actions. A blocked clarification or admission keeps its human
route. An admitted entry records a local advisory checkpoint inside the existing chat boundary;
it grants no additional file edits, test scope, publication permission or lifecycle decisions.
Preparation, draft-check and prepublish readiness never mark the generation published.
Direct phase-entry API consumers receive the same checkpoint. Native tracking arms only the
chat that actually requested its entry; another chat reading the same checkout cannot arm it.

When a host supports `agentStop`, a premature normal end of a full authoring/review task receives
one atomic continuation for that turn. It reuses the admitted context and already-read inputs.
It cannot reset repair budgets, start another model or phase, or approve, submit, fabricate evidence
or decide for a person. Genuine blockers, expired or changed bindings, pause, cancellation, an ended
decision and an already-used continuation end automatic follow-up. The existing draft and the
explicit owner route remain available. Explicit single-step and human-approval turns do not opt in.
Hosts without stop callbacks receive the same task and file-reader contract through CLI output.

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

Issued-path corrections remain exact hints, not grants. Real missing-file, sharing and permission
errors retain their native code, attempted path and read-only recovery/owner route. No input is
searched for, recreated or overwritten, and unchanged access is not retried automatically. Images,
binary files, special files and unsplittable single lines keep their native reader behavior.

Stop checks reuse the current turn's native file stamps. They scan no branches or Git history,
spawn no Git process and reload no repository policy. Checkpoints are local; published generations,
retained reviews, evidence and human decisions remain the durable sources of truth.
