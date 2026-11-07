# Incremental engine refactoring

Follow [the migration plan](docs/ENGINE-SDK-MIGRATION.md) when changing SFlow code.

- Refactor the responsibility involved in a change into its intended owner: kernel rules, SDK
  coordination, SDA persistence, SGOS execution, or host presentation and prompting.
- Keep extractions small and preserve existing records, hashes, error codes, authorization,
  recovery and public outputs. A changed public meaning needs its own versioned contract.
- Shared foundation and contract modules must remain independent of host I/O. Keep concrete Git,
  filesystem, process and provider implementations outside the future SDK's port contracts.
- New business operations must use one registered execution path. Do not embed CLI dispatch or
  command rendering in engine rules.
- Keep a necessary legacy dependency in an explicitly owned compatibility adapter and document
  the remaining coupling. Update meaningful regression tests and dependency guards with the slice.
- Describe the improved boundary, compatibility evidence and remaining work in each change.
- Run local checks for the affected components. Start Windows CI or live model qualification only
  when explicitly requested; neither is part of this foundation extraction.
