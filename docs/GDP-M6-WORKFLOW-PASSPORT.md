# GDP M6 — Workflow Passport and checkpoint compression

Inspect a creation-pinned Feature or Bugfix Story without changing it:

```text
singularity-flow delivery workflow-status <WORK-ID> --json
```

The projection uses the existing workflow record and Candidate identity. When a Candidate exists it
derives a Proof Subject and Change Passport. Each phase is compressed to a bounded checkpoint of
artifact, grounding, phase-input, evidence, and approval digests. Paths and document content are not
copied into the checkpoint.

Completed phases with no exact inputs report `unavailable`; active phases report `pending`.
Missing World Model data adds `WORLD_MODEL_UNAVAILABLE_NON_BLOCKING`. Missing Candidate data leaves
the Proof Subject and Passport unavailable. Neither condition blocks the original workflow.

Only Feature and Bugfix are mapped in M6. Other workflow profiles retain their creation-pinned
runtime and return a deterministic mapping-unavailable refusal. The view is model-free, read-only,
and is not consumed by lifecycle gates or publication authority.
