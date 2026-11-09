# Shared code-delivery replay

`src/kernel/code-delivery-evidence.mjs` owns the existing code-delivery v2 receipt replay rules.
The installed `verifyCodeDeliveryReceipt` adapter drives one replay and serves its explicit evidence
requests. The kernel imports only shared foundation and kernel modules. It does not select a
repository, read a file, launch Git, load a session, invoke a model, publish or approve a phase.

This removes the validation rules from the native receipt reader. It does not yet implement
namespace-backed application publication or finish migration Phases 5, 7, 8 or 9.
The [candidate preflight owner](ENGINE-SDK-CODE-PREFLIGHT.md) now shares the preceding generation
and fulfillment rules; its remaining native analysis/coverage dependencies are explicit.

## Rule ownership

The shared verifier preserves the original checks and their error order:

- generation commit/tree and committed change-set identity;
- change-set integrity, protected configuration materialization, source boundaries and symlinks;
- Auto Candidate identity and its published application delta;
- corner-case/assertion policy and immutable implementation explanations;
- existing, evidence, removal, document and configuration fulfillment;
- acceptance mappings, exact JavaScript declarations and committed source-comment bindings;
- attempt identity, generation/candidate binding and content-addressed raw report bytes;
- actual report replay, counts, occurrences, result identity and test-command pins;
- authenticated recovery/risk decisions, command coverage and pinned model assurance.

Exact configuration materialization now has one pure source-policy owner. The legacy facade keeps
its exports. Implementation-binding and corner-case digests also share the verifier's value rules;
existing hashes and records retain their meanings. The schema owner preserves the native replay's
existing numeric-string v2 admission. This does not broaden durable schema-family admission.

## Evidence requests

The synchronous rule generator yields a frozen request and consumes its answer, or receives the
actual reader error through `throw`. Only exhausting it returns a replay result. Reading its inputs
or stopping at an intermediate request does not establish validity, publication or human review.

Generation-tree/change-set reads and exact committed files remain source-control responsibilities.
Optional read-ahead requests have no acceptance result: the regular-file requirement, original
per-read size limits, hashes and exact-object fallback are still checked at their original places.
The native replay regression still reads eight source/test files, six attempts and six reports in
eight Git processes.

Test attempts and reports are raw immutable facts. The kernel hashes and replays their actual report
bytes using the shared report codec; it does not accept a reader's `ready` flag or a supplied passing
count. Report-codec initialization uses that same bound codec instance. Lexical declaration/tag
analysis is an explicit analysis dependency, rather than a filesystem dependency of the kernel.

The native host still supplies existing Auto Candidate decoders, authenticated TRP context,
test-command pin interpretation and accepted-risk policy. Those required owners are explicit
compatibility dependencies. Their absence or actual error is not converted into permission or
passing evidence. Extracting their remaining native policy coupling remains migration work.

The native return fields, execution order and distinctions between unavailable records, bad hashes,
permission errors and failed evidence stay unchanged. Failed executions are not silently removed
from the historical map; the existing failure findings and original command keys remain decisive.

## Qualification

Before extracting the verifier, the original `a09cfd37f` implementation produced the 90 real-repository
outcomes retained in `test/fixtures/code-delivery-evidence/native-v2.json`. The fixture records that
original function's fingerprint. The new verifier must reproduce every error, its order and the
execution identities. Separate tests drive the same rules entirely from in-memory facts, including
forged counts, changed report bytes, missing policy owners and real permission failures.

Architecture guards require the pure dependency closure, the single native replay path and shared
materialization exports. Existing source/test replay, fulfillment, claim, configuration and risk
journeys provide the native integration evidence. Qualification is on Mac only; Windows, installed
authority migration and a complete namespace-backed application Story are separate remaining gates.

The final affected suites passed 95 replay/architecture cases, 186 native regression cases
(including the opt-in fulfillment and environment-risk Story journeys), and 27 independently
installed SDK checks: 308 tests, with no failures, cancellations or skips. Source validation passed
3,946 checks across 191 skills. VS Code typechecking, the 2,011-site Git ownership audit and all
13 unchanged bundle budgets passed. The preview SDK retains 57 operations across 184 owned modules
and 1,794,097 JavaScript bytes. No Windows tests, live providers, real Stories, installs, merges or
pushes were performed.
