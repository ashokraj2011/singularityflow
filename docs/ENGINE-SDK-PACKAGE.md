# Installable explicit-port Engine SDK

`packages/engine-sdk` is a separate workspace member, `@singularity-flow/engine-sdk` at
`1.0.0-alpha.0`. It packages the existing versioned engine, shared failure identity, namespace
contracts and opt-in storage implementations. It does not import the existing `createSflow`
host factory: that compatibility API still performs native checkout binding and Git discovery.

Build with `npm run engine-sdk:build`, then pack with
`npm pack --workspace @singularity-flow/engine-sdk --ignore-scripts`. Install the archive in an
application or build-runner project. No source checkout or runtime npm dependency is needed.
The [package guide](../packages/engine-sdk/README.md) describes the exported entries and host
construction. The workspace is private to prevent accidental registry publishing; local archives
remain installable. This is an SDK preview, not a product release or a stable namespace v1 claim.

The package's core import has no infrastructure imports. Explicit filesystem, SQLite and
application imports keep concrete persistence outside the core; SQLite is loaded when selected.
The bundle uses shared ESM chunks, so all public entries use the same failure constructor. There
are no install scripts, executable shims, implicit provider calls, global Node changes or project
discovery. Core/filesystem/application support the root's Node 22 minimum; the SQLite capability
gate stays lazy and retains its qualification on managed Node 26.12.0.

Operation names, input keys and convenience aliases in the declaration build derive from the
executable engine registry. Helpers dispatch through `run`; they cannot become a second lifecycle
implementation. Declarations provide structural guidance, and runtime remains authoritative for
binding, review confirmation, admission and policy. Ports are trusted construction-time host
implementations. Supplying a port does not authorize an otherwise unauthorized actor or turn an
operation request into permission to approve.

The builder accepts only owned pure/kernel/SDK/namespace and concrete storage modules and a
small explicit Node builtin list. It emits no source maps, absolute build-machine paths or
external package dependencies. The inventory records source-relative modules and runtime hashes.
The build is completed in staging before promoting a recognized generated output directory;
unrecognized existing files/directories are preserved. Repeated builds have the same bytes.
Root CLI exports, runtime dependencies and installed Git authority are unchanged. The source
workspace link and full lock remain checked offline, including by real `npm ci --dry-run`.

Mac qualification exercises a real local npm archive installed in an isolated consumer outside
the checkout. It rejects infrastructure imports from the core with Node's actual module hook,
executes registered operations with preserved host failures, and denies unsupported deep imports.
Separate empty-PATH processes open filesystem and SQLite stores, reconcile the original receipt,
refuse changed operation intent and verify persisted data. The application entry exposes its
versioned port and shared pure reducer without choosing a database. NodeNext compilation verifies
all installed declaration entries and negative operation, field and scalar-type examples.

The initial package qualification passed 156 checks across 13 files on managed Node 26.12.0 with no
failures, cancellations or skips. It includes real source/bundled CLI/SDK publication, submission,
approval and preparation parity, plus filesystem/SQLite/application conformance and architecture
guards. The final seven-case tarball rerun also passes after tightening the witness-binding
declaration. Source validation passes 3,663 checks across 191 skills; VS Code typechecking and all
13 unchanged bundle budgets pass. The gateway remains 851 modules / 6,744,793 bytes. The build
contained 36 operations, 40 owned modules and 253,951 runtime bytes; the 24-file archive was about
63 KB compressed. These are artifact measurements, not complete-command latency claims. No
Windows, hosted CI, live provider, install, push, merge or real-project authority migration ran.

The later [content and read-host delivery](NAMESPACE-CONTENT-AND-READ-HOST.md) adds explicit
`content`, `storage/sqlite-content` and `hosts/namespace-reader` entries. It exercises real
namespace-backed phase/document reads with native reference/result parity and installed archive
resumption in a second process. Its partial read projection cannot provide approval proof or
publish/submit/approve ports. The application owns the content database connection and its durability
settings; local attachments still need matching device-local bytes. It does not import a CLI or
Git implementation into the core.

This closes the installable explicit-port package slice of Phase 7. Portable lifecycle writer ports
backed by namespace storage and a complete cross-agent Story remain required. Phase 5 policy/query
extraction, Phase 8 export/fencing/verified authority cutover and Phase 9 cleanup/distribution/
performance qualification retain their full scope. The ordinary installed CLI is still the Git
compatibility host; this preview does not migrate existing projects or select new authority.

The later [source-binding slice](ENGINE-SDK-SOURCE-BINDING.md) adds `source`, `sources/filesystem`
and `hosts/namespace-source` entries. Its installed archive exercises actual file observations,
conditional namespace acceptance and cross-process acknowledgement. Filesystem I/O is confined
to the explicit SGOS entry, outside the core import. Its metadata is a source observation, not
Git history, archived file content, generation readiness or completed phase execution.

The [artifact-template content rules](ENGINE-SDK-ARTIFACT-TEMPLATES.md) add the pure `artifacts`
entry. The native renderer and the SDK use the same token and namespace rules over text already
supplied by the host. Namespace approval validates referenced template tokens before acceptance.
Source reads, model instructions and machine-private draft persistence retain separate owners.
