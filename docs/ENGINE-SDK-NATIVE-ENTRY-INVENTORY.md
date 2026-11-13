# Native entry-point inventory

Run `node scripts/engine-native-entry-inventory.mjs` for the compact summary. Use
`node scripts/engine-native-entry-inventory.mjs --json > native-engine-inventory.json` for the full
development report. It parses selected checkout sources without importing handlers, discovering
Git history, reading a Story, starting a provider or executing an application command.

The audit at `29a9e6f11` covers 157 canonical commands with their original aliases, all 194 command modules,
and 1,507 reachable modules containing 28,318,081 source bytes. Ninety-two command entry graphs
reach the legacy dispatcher. These are syntax/reachability observations: each entry still needs
its original behavior qualification, and an entry can already call the SDK through a compatibility
wrapper. The existing registered-operation inventory records those separate bindings and qualifiers.

Every source fact has its relative path, actual content hash, byte count, literal imports,
resource imports, external dependencies and observed registered operation/helper calls. Cycles
are bounded. The report explicitly marks call-graph proof, runtime qualification, readiness and
authority as false. Literal paths remain inside the selected physical checkout; linked files,
malformed source and exceeded module/byte limits refuse a partial inventory. Actual filesystem
errors preserve their original details.

## Remaining dynamic boundaries

The 27 current non-literal import sites have explicitly reviewed component responsibilities:

| Responsibility | Current boundaries |
| --- | --- |
| Host adapters | CLI loader, runtime readiness and workspace index warmup |
| Host prompt composition | Token composition and phase prompt loading |
| World Model | AST replay and knowledge/rule command loading |
| SGOS adapters | Copilot provider loading and test environment execution |
| Source control | Repository commit-policy module selection |
| Native storage compatibility | Pinned configuration closure and amendment object reads |
| Native evidence compatibility | Corner cases, application review, artifacts and witness reads |
| Native lifecycle compatibility | Legacy environment/application transition composition |

These imports stay visible as unresolved syntax observations. A new dynamic entry without a
reviewed responsibility appears in `unclassifiedDynamicImports` and fails the real-checkout audit
test. No guessed module or successful provider result is supplied for an unresolved expression.

The executable vocabulary currently has 87 operations, 42 default native bindings and 76 namespace
bindings with private working stores. The report lists each of the remaining eleven namespace
bindings separately; two need optional actual execution capabilities. Native terminal plan review
retains its distinct ceremony, while portable plan-row context/record operations have their own
contracts. Risk/reuse/exception ceremonies and reviewed source adoption still need their genuine
owners. Phase 8/9 authority migration and production surface cutover remain separate.

## Qualification

Seven Mac cases pass: the actual complete checkout inventory, aliases/ownership coverage, inert
handler parsing, literal lazy imports and cycles, real missing-file diagnostics, bounded reads,
symbolic-link/escape refusal and malformed source. The temporary-path fixture uses the Mac's
physical directory, preserving the actual `ENOENT` path instead of normalizing the product error.
The audit changes development tooling only. It leaves the SDK package, native runtime, installed
authority and all existing performance ceilings unchanged. No Windows or live provider ran.
