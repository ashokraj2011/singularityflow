# Witness exception renewal rules

The shared witness component now owns selection of the current approved exception, renewal record
values and latest-expiry lookup. Native wrappers keep person-presence filtering, current human
authority, transactions and rendered commands. Original WXR records, generation/mapping identity,
expiry rules, errors and prior-approval hashes retain their existing meanings.

`@singularity-flow/engine-sdk/evidence` exports `witnessExceptionRenewalPolicies` and
`witnessRenewalExpiryValue`. The factory takes an explicit prior-expiry value callback and each
record takes an explicit timestamp. These helpers operate on supplied values; they cannot fetch
records, approve evidence, authenticate a reviewer or render a command. The native lookup still
passes its original presence-counted records before selecting a renewal.

Thirty outcomes were captured from the original native reader and record function at `68d584dbf`,
with both source digests, before extraction. They cover original/current/invalidated generations,
unknown mappings, date and reason errors, repeated renewal and original previous-expiry selection.
The capture is compatibility metadata, not new execution or approval evidence.

The native SDK and CLI journey also renews a real retained mapping after the Story has advanced,
without replacing the earlier approval or changing its generation, evidence or current phase.
Person-presence tests confirm that records count only under their existing verification policy.
The installed offline SDK replays the capture with an empty PATH, infrastructure imports and an
ambient clock denied, and strict NodeNext declarations.

Namespace mapping/exception recording remains unavailable until its original approved mapping and
human authority have their actual namespace owners. No namespace record or successful flag was
introduced by these value exports. That work and the other remaining owners stay on the Phase 5/7
completion ledger.

Mac qualification passes 175 affected checks across ten files, including the original standalone
34-check installed-package qualifier in 91 seconds within its unchanged 120/60-second deadlines.
Source validation passes 4,367 checks; VS Code types, the unchanged 2,011-site Git audit and all
thirteen original bundle ceilings pass. The gateway remains at 852/852 modules. No Windows,
production Story, installation change or main merge was run.
