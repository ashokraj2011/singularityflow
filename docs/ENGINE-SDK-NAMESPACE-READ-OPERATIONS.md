# Namespace phase inspection and Story queries

The opt-in namespace Engine implements `phase.prepublish`, `phase.draft-check`, `story.status`,
`story.guide`, `story.next` and `workflow.assets` through the existing operation registry. Native
Git hosts keep their original records, permission checks, projections and command guidance.

## Candidate inspection

Inspection reads the actual machine-local draft, original template, pinned configuration,
accepted inputs and retained policies. It does not stage publication, save content, write progress,
execute tests, or grant the reader the original author's write permission.

Shared specification, clarification, Code and conformance rules recompute the candidates. Candidate
text is passed as an explicit hash-and-size-bound byte argument. Reads of accepted upstream resources
still go through SDA, preserving actual missing-content and I/O failures. Candidate text cannot
substitute for an accepted resource with the same digest.

`phase.draft-check` reports authored-content health. `phase.prepublish` also checks required owners,
current source evidence and actual retained checks. Success admits a publication attempt; it does
not claim tests ran in this operation or that the transaction's final fresh check happened.

The reader authenticates its own permission. Author catalog checks use the original private draft's
agent as data. Completion rechecks permission, shared authority/revision, private body identity,
input resources and live source bytes. Concurrent writes fail explicitly. Frozen I/O errors keep
their original identity and details.

Content gaps and missing checkpoints/check evidence produce correction findings. A moved draft basis
preserves the draft and identifies rebinding. A missing configured owner is `ENGINE_PORT_UNAVAILABLE`;
unsupported requirements cannot become successful flags. An observed partial conformance verdict
does not claim its human decision is still open: approval evaluates the actual original disposition.

## Story and workflow reads

Status reports the accepted namespace revision and recorded evidence counts. It makes no claim about
separate Git publication markers. Guide and next-step planning share the kernel rules. The next-step
reader also observes private draft progress so an already modified draft reaches inspection instead
of restarting generation. Stale drafts retain recovery observations. These reads grant no mutation
or approval authority.

Workflow inventory follows the approved package's phase/agent dependency closure through nested
skills, instructions and templates, retaining names from shared configuration catalogs. It includes
no prompt bodies, local attachment content or import authority. Unknown workflow selectors fail.

Unbound standalone decisions are refused before I/O. They cannot fall through to route choice and
incorrectly demand a routing confirmation. The discrepancy parser now has one pure kernel owner;
its compatibility entry re-exports the same functions. Ownership, full text, source-item hashes and
deduplication share pure rules; native adapters still provide presence-counted records.

## Qualification and scope

Mac regressions cover all three namespace backends, independent readers, actual source/test bindings,
specification checkpoints, shared-only retained reads, exact errors and concurrent writes. Existing
native discrepancy tests protect ownership and deduplication. The remaining owners and cross-agent
qualification in the [completion ledger](ENGINE-SDK-PHASE-5-7-CLOSURE.md) remain open, including
namespace artifact-derived issue filing. No Windows, hosted CI, live model, installation mutation
or main merge is part of this delivery.

The completed Mac groups pass 167 distinct focused cases with no failures, cancellations or skips.
They include ordinary and private reads, specification analysis, Code publication, Release conformance,
scope/plan decisions, monotonic generation and architecture checks. The unchanged installed SDK
qualifier passes all 34 cases in 79 seconds, within its existing 120/60-second limits. Source
validation passes 4,130 checks; schema admission, VS Code types, the unchanged 2,011-site Git audit
and all 13 unchanged bundle ceilings also pass. The gateway remains at 844 of 852 modules.
