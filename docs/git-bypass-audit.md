# GAL Git bypass regression gate

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
