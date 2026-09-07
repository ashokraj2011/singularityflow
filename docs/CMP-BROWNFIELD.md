# CMP brownfield adoption

Singularity Flow adopts an existing repository incrementally. It does **not** require every legacy
file to be explained before new work can proceed, and it never invents historical intent.

## Inspect the touched area

```bash
singularity-flow comprehension brownfield --base HEAD --json
```

The command reads the same exact repository change set as the other CMP diagnostics and classifies
only its changed regions:

- `new-region` requires a current governed cause;
- `legacy-touched` requires a current governed cause;
- `mechanical-move-candidate` means an exact Git object was renamed without a mode change, but the
  legacy label is **not** retained until a separately reviewed transformation receipt exists.

Unchanged files are neither scanned nor silently classified. Their default label remains
`legacy-unexplained`. The result is model-free, AST-free, read-only, non-authoritative, and cannot
block a lifecycle gate.

## Validate a partial historical proposal

Historical backfill is optional and may cover one module rather than the whole repository. Put the
proposal in an ignored repository-local review directory, then run:

```bash
singularity-flow comprehension backfill validate review/backfill.json --base HEAD --json
```

Minimal proposal shape:

```json
{
  "schemaVersion": 1,
  "kind": "comprehension-historical-backfill-proposal",
  "sourceRevision": "0123456789abcdef0123456789abcdef01234567",
  "scope": { "kind": "module", "path": "src/payments" },
  "entries": [
    {
      "path": "src/payments/capture.js",
      "assurance": "unknown",
      "causeRefs": [],
      "evidenceRefs": [],
      "decisionSha256": null,
      "entrySha256": "sha256:<canonical-entry-digest>"
    }
  ],
  "proposalSha256": "sha256:<canonical-proposal-digest>"
}
```

Entries must be sorted by path and remain inside their exact repository or module scope. The closed
assurance labels are:

- `historically-confirmed`: proposes a cause with evidence and an exact existing approval-decision
  reference;
- `historically-inferred`: records evidence-backed inference without a human decision digest;
- `unknown`: records no historical cause.

Validation checks bounds, paths, scope, source revision, closed reference kinds, and content
digests. It does not decide whether history is true. Every result remains an untrusted proposal
until CMP P2 integrates it into the existing Story review and publication authority. There is no
standalone CMP approval or publisher.

## Safety properties

- Proposal files inside the change set they describe are refused as circular input.
- Absolute paths, traversal, Windows drive paths, backslashes, duplicate paths, unknown assurance
  labels, placeholders, stale revisions, and digest changes fail validation.
- A `historically-confirmed` label without an exact approval-decision reference is rejected.
- An inferred or unknown entry cannot acquire confirmation merely by passing validation.
- No command writes a record, invokes a model, builds AST, changes Git, or advances a Story.

See [CMP roadmap](CMP-ROADMAP.md) for the remaining authority, persistence, and physical-host
release work. The same transient assessment is available under **Comprehension Center →
Brownfield** in VS Code; opening it neither scans unchanged legacy files nor writes a proposal.
