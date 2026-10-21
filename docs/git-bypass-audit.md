# GAL Git bypass regression gate

Workspace clone resumption adds three fixed local observations (`origin` configuration, symbolic
HEAD and exact HEAD) through a bounded Git launcher in `workspace-clone-claim.mjs`. They use the
existing sanitized enterprise environment, disable optional index locks and lazy fetching, and
have a 30-second deadline and 1-MiB output ceiling. The retained configuration digest is checked
before resumed Git inspection. Worktree identity reuses the existing fingerprint owner; no new
remote operation, executable selector or general Git owner is admitted. The workspace owner's
existing call counts remain unchanged; its reviewed digest changes for the preparation wrapper.
Only these exact local call sites are added to the frozen baseline.

One-command distribution adds only fixed bootstrap/setup wrapper sites: two shell sites in
`build-distribution.sh` select the existing checksum-pinned private runtime and its fixed build
module; one in `build-distribution.cmd` enters its fixed PowerShell build script; one in
`distribution/setup.sh` delegates to the existing managed installer; one in `distribution/setup.cmd`
delegates to the SystemRoot PowerShell entry without reparsing argv. Both CMD wrappers scope their
execution policy to the child process only and cannot override enterprise Group Policy.
None invokes Git or accepts arbitrary executable text. Product setup reuses the existing bounded
installer process primitive and central platform adapter for the fixed VS Code/Copilot forms;
the user PATH helper selects only SystemRoot PowerShell and CurrentUser registry scope. No new
general process/Git owner or transport exemption is registered.

The shared-read paired benchmark has two bounded launch sites: read-only Git source identity
(30 seconds, 4 MiB) and fixed Node CLI reads against its owned temporary clones (180 seconds,
16 MiB). Setup uses the existing warm-read fixture owner. It alternates installed baseline and
candidate engines with independent compile/provenance caches; no production process owner,
model permission or transport capability is added. Only its exact reviewed site digest is added.

`scripts/classified-performance-benchmark.mjs` has two reviewed Node launch sites:
fixture initialization and alternating traced/untraced allowlisted reads. Both
use structured argv, a 60-second timeout and a 4-MiB output ceiling. They execute
only the copied warm-read fixture, with private machine state and unconditional
cleanup. No real Story, provider or remote is contacted, and no production Git
owner or transport permission is added.

Workspace retention adds one bounded maintenance launcher for a shipped, fixed Node worker;
its launch packet accepts only an absolute workspace and protected paths. The packet is one
environment variable the worker removes before any work, not an IPC message: an ES-module
worker is evaluated asynchronously and dropped a message that arrived first. It never runs a model,
publication or approval. The foreground skips disabled/not-due work, and the worker rechecks
policy and owns the maintenance lease. The retention proof uses the existing isolated Git
environment, local configuration checks, exhaustive worktree fingerprint, bounded Git reads and
exact remote advertisement. Its only destructive Git form is `worktree remove -- <owned-path>`
without force. Clone retirement/purge remains with the existing drop-proof owner. These two
reviewed site fingerprints are frozen; no new general Git/process owner is registered.

Shared execution context adds no Git/process owner. The existing bounded CLI-step launcher now
passes the kernel-returned checkout to its child process when a surface is explicitly bound; it
does not accept a profile replacement or broaden its argv. Story-worktree calls are unchanged but
now sit inside a clone-lifecycle lease (`prepareStoryWorktreeInLease`). Their two reviewed site
digests change without increasing the process/Git call counts. Inventory reuses the existing
worktree reader and strict capability-drop proof; VS Code remains a thin CLI client.

Capability history optimization reuses the existing bounded, private configuration-object owner.
Its two new `update-ref --stdin` sites install freshly advertised exact proposal OIDs in bounded
pages, one transaction in the retention pool and one in the disposable checkout. Ref names cannot
contain whitespace; Git validates the complete batch before writing. Complete capability-object
pools are separate from filtered workflow pools and retain the existing private-directory, lease,
size, file-count and frozen-transport checks. Mutation/review clones use `--dissociate` so retained
push recovery owns its objects independently before the pool lease ends. The new capability
checkout wrapper adds one fixed, bounded `checkout sflow/config` through the existing process
primitive, only in its freshly created disposable clone. Ledger history calls retain their existing
owner/count and now scope publishing pathspecs before traversal; the Windows argv bound falls
back to the previous `singularity` scope. No general process or transport owner is added.
Configuration refresh proves a single orphan root and linear ancestry in one exact-commit
`rev-list --parents` call, replacing two traversals with the same ten-second deadline and a bounded
output. Unreadable or nonlinear histories still refuse before any authority mutation. Generic
fact reuse remains opt-in to eligible environments and never overrides isolated transport policy.

`scripts/repository-check-benchmark.mjs` has one reviewed process import and one bounded Node
launcher (90 seconds, 32 MiB, structured argv). It runs copied CLI code against the existing
local-only warm-read fixture, with private machine state, no models, no network and unconditional
fixture cleanup. It measures routine entry commands and is imported only by its focused tests,
never product handlers. Its frozen baseline adds no production Git owner or transport authority.

Onboarding activation's three new local Git sites initialize an inert, template-free bare store,
configure its frozen remote alias, and verify its exact fetched state commit. They run through the
existing bounded process primitive under the reviewed enterprise environment. No application branch
is fetched or checked out. The ledger retains its existing 80 Git / two process sites: initialization
and append share the same canonical object builder, and paired direct-ref observations retain
dangling-symbolic-ref probes, exact old-value leases and failure classification. Only these owners'
reviewed fingerprints change; no process owner is added.

`scripts/onboarding-activation-benchmark.mjs` adds one bounded Node launcher (180 seconds, 32 MiB,
structured argv) for copied installed runtimes and seven fixed setup/inspection Git sites delegated
to the existing disposable fixture owner. Both control and candidate use separate local bare
remotes, machine registries and V8 caches. It never runs a model, contacts a provider, mutates the
source checkout, or activates a real repository. Its exact call-site fingerprint is frozen, not a
new production process allowance.

The utility-entry qualification harness adds one bounded Node process launcher (90 seconds,
8 MiB, structured argv) for copied SFlow runtimes inside an owned temporary fixture. Three call
sites invoke fixed pause, initialization and allowlisted utility-read forms. Git setup stays in
the existing warm-read fixture owner; no provider, remote or caller repository is changed.
The exact reviewed fingerprint is frozen; this is not a new product process owner.

Intake preparation adds a narrow cleanup path to the existing Story-worktree owner, not a new
general process owner. It runs `worktree remove` without force only after exact managed-path,
common-directory, staging-branch, initial-commit and tracked/untracked/ignored-cleanliness checks.
The staging ref is deleted with `update-ref --no-deref -d` and the exact initial old value; a
concurrent ref advance remains reachable. The prior per-spelling staging probes are replaced by
one bounded ref listing. Only this owner's reviewed call-site fingerprint changes in the baseline.
The qualification fixture's existing Git launcher additionally retains its original failure as an
error cause when bounded temporary cleanup fails on Windows. Setup-only indexing suppresses LF
round-trip warnings with `core.safecrlf=false`; autocrlf and measured checkout policy are unchanged.
Its launch count, timeout and authority are unchanged; only that existing wrapper's fingerprint changes.

Large-Story configuration reads add one fixed local Git call in the existing configuration
owner: `read-tree -mu <exact-commit>`. It runs only
inside the freshly cloned disposable checkout under the frozen enterprise environment. Patterns
are anchored, glob-escaped exact configuration paths plus ancestor attribute/ignore files, derived
from committed policy. The full index preserves omitted application entries during scoped
enrollment; no caller checkout or index is changed. The complete snapshot/authority validation
still follows. Only this owner's new call-site fingerprint is added to the frozen baseline.
Sparse settings are confined to clone-local config; the pattern file is exclusively created under
real clone-owned metadata directories. This uses longstanding plumbing instead of newer
`sparse-checkout set` options, and does not add a general mutation owner.

The isolated-start transaction reuse adds two reviewed read-only calls in the existing
configuration owner: status of its own disposable checkout before one-use enrollment, and the
committed successor/parent pair before retaining a snapshot. Both use the enterprise-isolated Git
environment, bounded fixed arguments, and the existing checked-result boundary. They add no
transport, arbitrary shell, caller-supplied checkout, or mutation owner. Their frozen call-site
digests are updated with the regression tests; the registered-owner list is unchanged.

The existing local warm-read fixture keeps the same two bounded process launchers. Its Git
setup deadline is 120 seconds on Windows (30 elsewhere) with a 4 MiB output bound, after the
10,000-file Windows setup timed out while staging CRLF-converted fixture files. This changes
qualification setup only, not product command deadlines, Git policy or measured workload timing.

`npm run check` runs `scripts/git-bypass-audit.mjs` as part of the release checks. The gate scans production JavaScript/TypeScript in `src/`, `bin/`, `apps/vscode/src/`, `plugin/extensions/`, and `scripts/`, plus installer/distribution shell wrappers and root/workspace npm script commands. Test fixtures are intentionally out of scope. The audit and aggregate check scripts themselves are excluded because they are check infrastructure, not production execution paths.

The nine registered process/compatibility owners are listed in the audit script and recorded in `scripts/git-bypass-baseline.json`. Other observed sites are frozen by file, category count, and a digest of their normalized call expression and enclosing function. The 2026-09-18 snapshot contains 1,522 legacy sites in 194 files and 93 sites in registered owners. These are conservative **process/Git candidates**, not 1,615 actual Git spawns or a compliance claim; legacy `run(...)` sites include non-Git commands. Shell-wrapper candidates also include broad launcher keywords. The local-only `scripts/gal-read-benchmark.mjs` is explicitly excluded because its sole child-process site creates a temporary fixture, not a production Git path; its bounded behavior has a separate focused test. The registered `scripts/gal-matrix-cell.mjs` is qualification infrastructure, not an application Git-mutation owner.

This is a regression gate for new static sites. It catches direct Git calls, generic process-launch calls, imports and aliases of child-process launchers, `run('git', ...)`, known `git(...)` wrappers, Git literals passed to arbitrary wrappers, and shell Git/launcher lines. It does not prove that existing legacy sites satisfy GAL. Dynamic executable selection, renamed wrappers, generated code, and behavior reachable only at runtime require integration probes and owner review under [GAL:REQ-033].

When the gate fails, inspect the reported file with `node scripts/git-bypass-audit.mjs --print-sites path/to/file`. Migrate the new call through GAL when possible. If a legacy site has deliberately changed or been removed, review its effect/trust owner and update the baseline from `--print-baseline` in the same change. Review the baseline diff rather than treating a regenerated digest as an automatic waiver. Adding a registered owner is an architectural decision, not a way to suppress a call-site failure.

The missing-installation-receipt repair adds one reviewed shell process site in `install.sh`:
`exec node` enters the product-only repair helper for a full, explicitly test-skipped install.
It releases the normal activation lease before the helper reacquires the shared lease and
rechecks receipt absence. This adds no Git lookup or workspace mutation; partial installs
and active recovery are not widened or discarded. Build and artifact checks remain required.

The Story-intake performance change extends the existing `test:platform:windows` Node test command
with Git-fact invalidation and intake receipt/start suites. Its reviewed package-script digest changes
only because those test paths are added; it adds no production Git owner or launcher.

The proposal-performance change removes two legacy ref-resolution sites from
`src/configuration-proposal.mjs`; the same exact commits are resolved during hydration in that
invocation's disposable checkout. Its fresh remote push/lease verification is unchanged.
`scripts/proposal-performance-benchmark.mjs` has one frozen process launcher and fixture Git calls:
it creates its own bounded temporary application/configuration repository and local bare remote,
redirects SFlow machine state, invokes the CLI with models disabled, and removes only its fixture
in `finally`. It is never imported by product commands and is not a registered Git owner.

The opt-in `src/skp-docker-hash-probe.mjs` has one reviewed process import and one launch in its fixed Docker CLI hash helper. It is deliberately a frozen baseline site rather than a registered owner: changing the launcher call must trigger a fresh review. That candidate stages inert bytes, requires a local digest-pinned image with no pull, and never grants SKP lifecycle execution or host qualification. The GAL signature checks the import and launch expression; the probe's focused tests check its Docker arguments, environment, output bound, and refusal paths.

The bundled Java semantic AST adapter, `src/ast-packs/java-semantic-adapter.mjs`, has one reviewed process import and one launch: it runs the packaged `JavaCallResolver.java` on the `java` launcher found on `PATH`, the toolchain a confirmed `wm ast warm --semantic --provider sflow-java` bound the project to. It never runs Git, Maven, Gradle, or repository code; the resolver reads sources as data with an empty class path and no annotation processors. The adapter is itself an out-of-process pack started through the bounded adapter runner (structured argv, closed environment, time and output limits, tree kill), and it must stay self-contained so retained evidence can replay it, so it cannot import the hardened process primitive. It is a frozen site, not a registered owner.

The bundled Python semantic AST adapter, `src/ast-packs/python-semantic-adapter.mjs`, has one reviewed process import and one launch: it starts Singularity Flow's own Pyright language server (`node_modules/pyright/langserver.index.js`, digest-bound by the pack manifest) on the Node that runs the adapter, over stdio, with no `PATH`, so Pyright never runs a Python interpreter, pip, Git, or repository code. Like the Java adapter it is an out-of-process pack under the bounded adapter runner and must stay self-contained for replay. It is a frozen site, not a registered owner.

`src/git-hook-effects.mjs` has one reviewed local `git status` observation site. It uses the hardened process primitive, disables filesystem-monitor hooks and optional index writes, and caps time, output, and path count. It observes Git-visible paths and metadata before and after actual publication, not during intake. An unavailable observation never blocks publication or attests that the checkout was unchanged; ignored files and byte-exact integrity are outside this observation. No files are deleted. This is a frozen site, not a new registered process owner.

`src/session-state-index.mjs` has one reviewed local `git ls-tree` observation site. It enumerates
only `ledger/head.json` and `ledger/entries` at an already verified immutable state commit, with
lazy fetch and replacement objects disabled and explicit time/output/record bounds. It does not
ask for blob sizes during tree enumeration. Missing blobs are fetched separately by the existing
deadline-aware ledger transport, only by tree-proven object ID; hash verification and byte bounds
still apply. It never scans application branches or history, changes a checkout, or initializes state.

Source review moves six per-file Git sites into `src/source-review-snapshot.mjs`: two exact HEAD
reads (entry and final retention recheck) and two buffer-preserving individual fallbacks. Named
inputs use the existing hash-verified object batch reader with a 32 MiB aggregate prefetch ceiling.
One reviewed Git executable-resolution literal binds the cache key to the actual Git installation;
it does not launch Git. Immutable UTF-8 provenance facts use
the existing private Git cache with its configuration, shallow/graft/replacement and object-store
invalidation. The two path-scoped introduction-history proofs remain in the lifecycle reader.
The final retention and human-decision checks bypass every Git fact and shared review packet.
These sites remain frozen baseline entries, not new registered process owners.

`scripts/source-review-benchmark.mjs` has a reviewed process import, two process launch sites and
five Git fixture calls. It creates disposable published Stories, runs the real context/stage/check/
retain/status CLI, measures child counts and elapsed time, and cleans only its own temporary
repositories. It never contacts a model or remote, publishes to an application repository, or
records an approval. It is qualification tooling, not an installed command.

`scripts/source-review-paired-benchmark.mjs` adds one frozen process import and one launch of the
same fixed benchmark driver on the current Node executable. It alternates explicitly selected
baseline/candidate engines over disposable fixtures to reduce host-load order bias, retaining all
observations. Arguments are structured, runtime/sample/profile choices are bounded, output and
execution time are capped, and no shell is used. The driver owns fixture isolation and cleanup.
This site is never imported by a product command and does not extend the registered Git owners.

Creation critical-path changes relocate the existing fixed Node worker launch from
`ast-story-start-warm.mjs` into `ast-warm-launcher.mjs`; there is no new caller-supplied executable
or shell. Clone metadata combines branch and HEAD in one fresh Git read. Fingerprinting combines
index stage and flag reads while preserving its canonical manifest. Removed launch/read sites are
removed from the frozen baseline rather than exempting their owners.

The creation benchmark's reviewed launches use the current Node executable, bounded fixture-owned
arguments, disposable local remotes, capped output and deadlines. Its test-only preload counts
Node-launched Git operations, including legacy async spawns, retaining only verb counts and elapsed
times, never argv/URLs/credentials. Baseline and candidate have separate installed source roots, so
dynamic imports cannot silently load candidate code into the baseline. These scripts are not
imported by product commands and confer no new Git ownership or runtime permissions.
