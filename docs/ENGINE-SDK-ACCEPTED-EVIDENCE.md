# Accepted lifecycle evidence for namespace Stories

An immutable publication, submission packet or human-vote blob can exist before its conditional
operation commits. Valid bytes, a matching generation and an approval threshold alone do not
establish acceptance. Namespace business readers now verify the original accepted operation before
using those records as downstream evidence.

## Compatibility boundary

The lifecycle writer and read-only receipt reader share a frozen v1 codec. It describes logical
keys, prepare and commit transactions, head/manifest projections, request digests and receipt
validation. The codec receives an explicit UTF-8 digest capability; native hashing remains in the
host. Existing imports of the one-argument Story key helper retain their API.

Actual publication, submission and approval records captured from `8c0047454`, before extraction,
qualify their original manifest bytes and both transaction digests. No record is rewritten or
restamped. Registry mutation admission and effects remain in the existing conditional writer.

## Read-only acceptance proof

The reader verifies the immutable prepared intent, its original prepare receipt/revision, the
commit receipt, the immutable operation manifest/revision, the exact configuration revision and
the original and resulting state bytes. Typed evidence owners additionally verify the operation,
request digest, original revision, evidence inventory, phase generation and resulting bindings.
The Story observer compares historical policy with the genuine creation proof.

Publication and submission readers expose accepted paths separately from candidate decoders.
Human-vote readers likewise distinguish candidate verification from accepted prior votes. Writer
self-checks can still validate an interrupted candidate before commit; that candidate cannot be
used as an approved input or completed human decision.

Preparation checks accepted upstream publication, submission and human quorum before issuing an
approved input. Submission, approval, routed reuse, human-choice questions and review-resource
queries share these readers. Valid preparation-context and evidence formats remain unchanged.

Receipt reuse is limited to a single proof traversal and retains only accepted immutable facts.
Failures and pending results are not retained in the cache. A new traversal rereads storage;
mutable policy is compared again, and existing final head/authority and conditional-write checks
remain in place. Historical same-epoch receipts remain readable after a later head or fencing.

Missing or merely prepared operations return `ENGINE_OPERATION_NOT_COMMITTED` with the original
operation ID and observed status. The caller must resume that original operation. Missing records,
unsupported schemas, corrupt bindings and invalid port receipts retain separate errors. Actual
permission/deadline exceptions retain their original objects and details. Inspection never writes,
repairs storage, samples a new clock or grants a human identity.

## Qualification

Mac qualification on Node 26.12.0 passed 555 checks across 33 files, with no failures,
cancellations or skips: 120 portability/receipt cases, 416 host cases and 19 separately installed
SDK cases. The installed consumer completed in 41,793 ms within the unchanged 120-second parent
bound. These are qualification timings, not a controlled performance comparison.

Coverage includes all three metadata backends, real pending/accepted distinction, changed or
missing receipts/manifests/revisions, unsupported schemas, actual timeout identity, scoped reuse,
cancellation, historical fencing, independent human quorum, branching, rework, human choices,
cross-process acknowledgement and unchanged preparation-context fields. The new upstream-input
regression withholds each actual publication, submission and human-vote receipt in turn, requiring
an explicit failure without a private draft or Story-state change.

Source validation passed 3,860 checks across 191 skills. VS Code typechecking, the unchanged
2,011-site Git ownership audit and all 13 production bundle budgets passed. Gateway and extension
remain 851 modules / 6,860,814 bytes and 152 modules / 1,291,045 bytes. The explicit SDK preview
builds 51 operations over 127 modules and 1,291,277 bytes. No ceiling changed. No Windows, hosted
CI, live provider/model, real Story/workspace, product installation, migration, merge or push was
involved; package installation was confined to a disposable offline test consumer.

## Remaining scope

This establishes acceptance provenance for the implemented namespace document profile. It does
not migrate an installed project, introduce application/test execution, change Git authority or
complete the remaining native queries and policy owners. Phases 5, 7, 8 and 9 remain open.
