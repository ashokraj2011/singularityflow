# Recreate & sync configuration (removed)

Recreate & sync was removed in SPEC-SCF stage 2 ([SPEC-SIMPLE-CONFIGURATION-v1](SPEC-SIMPLE-CONFIGURATION-v1.md)).
It replayed every pending proposal at once, teammates' unreviewed ones included, and let a proposal's
value win over a value that had already been approved (finding ER-F2).

What replaces it:

- Each proposal is approved on its own: `singularity-flow configuration approve <PROPOSAL>`, or Workflow
  Studio → Changes → Review and activate. The approval lands exactly the change that was shown, from the
  proposal's merge base with `sflow/config` to its tip, however many commits it has [SCF:REQ-005, REQ-006].
- When `sflow/config` moved after the proposal was made, approval re-applies the proposal's field edits on
  top of it. It asks only about a field both changed differently, and the approver keeps one of the two
  values (`--pick <FILE>#<FIELD>=proposal|current`, a question in the terminal, or a choice in VS Code)
  [SCF:REQ-007].
- Running approve again on an approved proposal finishes whatever an interruption left [SCF:REQ-009].

`singularity-flow configuration recreate-sync` now refuses with `CONFIGURATION_RECREATE_SYNC_REMOVED` and
names `configuration approve`. Backup tags an earlier run left (`sflow-config-recreate/*`) stay as they are
and are never read as authority [SCF:REQ-003].
