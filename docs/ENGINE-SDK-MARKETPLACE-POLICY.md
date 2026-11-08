# Portable marketplace trust and remote-content rules

The kernel owns marketplace declarations, public HTTPS URL admission and the existing blocked
address ranges. Native marketplace and network readers bind that same compiler to explicit
network-address primitives. The workflow compiler no longer accepts `normalizeMarketplaces`
or `worldModelStateAuthority` callbacks; its seven composition entries include the address
syntax capability instead. These changes do not approve a marketplace or configuration.

## Ownership

`kernel/configuration-policy.mjs` owns the original marketplace field checks, label limits,
allowed-origin rules, template-token rules, IP restrictions and 26 blocked subnet declarations.
Its factory returns frozen function bindings. Private regular expressions stay private; an
index reader receives the ID predicate rather than a mutable validation expression.

`engine-compatibility/node-network-syntax.mjs` supplies the frozen
`sflow-network-address-syntax/v1` capability: `profile`, `isIP` and `containsSubnets`. It uses the
same Node IP classifier and BlockList implementation as before. There is no parser approximation
or network access in this adapter. It compiles the kernel's frozen subnet data lazily and caches
only that immutable value syntax, not addresses, URL checks, DNS answers or admission outcomes.
Factory construction calls no primitive and does not evaluate a function's `bind` accessor.

Native DNS, redirect handling, address pinning, request deadlines, bounded bodies, hashes and
index readers retain their existing owners and implementations. Every resolved address and
redirect still passes the shared rules; a cached subnet representation never replaces a fresh
address or URL check.

The shared declarations module owns the unchanged precedence of historical Git-configuration
values for World Model state references. The former state-authority module aliases that rule.
Computing `branch` and `remote` values does not choose, open or migrate a storage backend.
Namespace project authority remains subject to its own enrollment and lifecycle contracts.

## Compatibility evidence

The pre-edit baseline at `526b69e73` retains 118 address outcomes (including before/after subnet
boundaries), 28 URL outcomes, 27 marketplace results and nine state-reference projections.
It captures existing exceptions, normalized bytes and hashes, frozen output shape, all 26 subnet
pairs and native module export inventories. Six relocated rule bodies and two private constants
retain their exact syntax. Seventeen native DNS, index and fetch function bodies are unchanged.

Runtime/commit-policy compatibility, remaining native queries, complete namespace-backed Story
execution, verified migration and final package/performance qualification remain required.
This extraction does not change installed Git behavior or complete those milestones.

## Mac qualification

The affected suite passed 333 tests across 32 files with no failures, skips or cancellations.
It covers original compiler/configuration cases and all seeded workflows, marketplace and APM
imports, agent dependencies, remote-content checks, World Model authority/census behavior,
workflow proposals and intent, publication parity and real SDK/VS Code package consumers.

Source validation passed 3,763 checks. VS Code typechecking and the Git-boundary audit passed;
the audit retains 2,011 registered production sites. All thirteen existing bundle limits pass:
the gateway has 851 modules and 6,826,689 bytes, the extension has 152 modules and 1,288,167 bytes,
and prewarm has 23 modules and 104,331 bytes. No bundle limit was raised. This is local Mac
qualification; no Windows CI, live model run or installed-project cutover was performed.
