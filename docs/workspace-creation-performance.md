# Workspace creation and Story intake qualification

For the subsequent shared-capture, publication batching, Windows ACL and selected-configuration
work, see [Story creation context qualification](story-start-context-performance.md). Its matched
baseline/candidate cohort is separate from the historical measurements below.

## Recorded results — 2026-10-21

Both native qualification jobs passed 65 modified-area tests with zero failures/skips, plus one
resumed-workspace case each. The copied-workspace regression passed separately on both hosts. The
earlier Windows workspace/clone-recovery step passed all 141 cases; subsequent FOS, ACL, worker and
resume changes were covered by the final targeted runs. Checks, VS Code typechecking and builds
passed. This is not full release qualification.

Installed-build medians in seconds below compare baseline to candidate. Workspace/Story rows use
three samples per variant/mode; 10k and intake rows use two (the mean of the two middle values).
The baseline is `a0fc9d19`; the qualified runtime is `5d73cfdb`. Final test-only follow-ups do not
change runtime behavior. Native qualification/measurement run: `39545312394`; final copy check:
`39545814760`. Node and Git versions, every sample and separately charged prewarm costs are in
[the raw results](workspace-creation-results.json).

| Request | Native Mac cold | Native Mac prewarmed | Windows cold | Windows prewarmed |
| --- | --- | --- | --- | --- |
| Workspace, 1k files | 2.823 → 2.046 | 2.658 → 1.868 | 6.295 → 5.313 | 6.028 → 5.139 |
| Workspace, 10k files | 3.988 → 3.715 | 4.059 → 3.165 | 12.931 → 10.136 | 12.563 → 9.637 |
| Isolated Story start | 6.839 → 7.062 | 6.120 → 5.845 | 18.405 → 18.124 | 20.254 → 24.458 |
| Readiness + isolated start | 8.164 → 9.130 | 8.362 → 7.781 | 26.481 → 29.930 | 29.765 → 30.736 |

Workspace creation consistently improved in this cohort: approximately 16% cold on Windows for
1k files and 22% for 10k files. Git launches fell from 71 to 62 on both native runners. On the local
Mac, the 1k-file medians were 1.196 → 0.943 seconds cold and 1.055 → 0.909 prewarmed, with Git calls
73 → 64. Absolute counts/times differ across hosts, so compare variants within a host rather than
pooling different host environments.

Story/intake latency is **not consistently improved**. Isolated-start Git calls fell 225 → 219 on
native Mac and 211 → 205 on Windows; combined intake calls fell 298 → 293 and 267 → 262 respectively.
Nevertheless some medians worsened, notably Windows prewarmed Story start (+20.8%). Its candidate
range (18.566–25.822 seconds) overlaps the control range (18.412–25.961 seconds); this small, variable
cohort cannot establish a causal regression or a speedup. Do not market general Story latency
savings from these measurements. Authority loading, enrollment and publication remain substantial
costs and need further profiling. No slow samples were removed.

The 10k Windows harness previously timed out creating loose synthetic objects before a measured
request. Packed seeding fixes that setup failure without reducing file count/content diversity.
All rows above use the corrected packed profile, not a mixture of old and new fixture layouts.

## Reproduce

Use the same Node version and idle host for both variants. Substitute a full immutable baseline
commit for `BASELINE`; the scripts compare bounded changed runtime modules, not arbitrary refs.

```sh
node scripts/workspace-creation-benchmark.mjs --samples=3 --files=1000 --control-ref=BASELINE --out=workspace.json
node scripts/workspace-creation-benchmark.mjs --samples=2 --files=10000 --control-ref=BASELINE --out=workspace-10k.json
node scripts/story-creation-benchmark.mjs --samples=3 --files=1000 --mode=isolated --configuration=approved --fresh=true --control-ref=BASELINE --out=story-cold.json
node scripts/story-creation-benchmark.mjs --samples=3 --files=1000 --mode=isolated --configuration=approved --fresh=true --prewarm=all --control-ref=BASELINE --out=story-prewarmed.json
node scripts/story-readiness-benchmark.mjs --files 1000 --output readiness.json
node scripts/intake-creation-benchmark.mjs --samples=2 --files=1000 --control-ref=BASELINE --out=intake.json
```

Workspace samples always create a fresh target and identical independent remote, including the
first state initialization. They never compare cold creation with warm no-op repair. Story samples
verify that the exact created branch tip was published, not merely that the CLI exited zero.
Variants alternate order. Both receive the same prewarm operation in `--prewarm=all`; preparation
time is reported separately and included in total-with-preparation, not presented as saved work.

The installed fixture includes `runtime/`, required by managed runtime resolution. Baseline bundles
are built in a separate installation with their own baseline `src/` and executable. This also
isolates dynamic package-root imports, which choosing a different bundle directory alone cannot
do. The fixture builder requires a local checkout of the baseline commit and at most 32 changed
runtime modules. Synthetic fixtures and private caches are removed after qualification.

## Interpret correctly

- Cold means a fresh Node process and empty private compile cache. OS disk caches are not flushed.
- Prewarmed request time excludes the separately reported runtime preparation cost.
- `nodeLaunchedGit` counts Git invocations made by the measured Node request, including direct async
  spawn sites omitted by some legacy product counters. It excludes detached workers and Git's own
  internal child processes. It records verb counts and inclusive elapsed time, not arguments.
- Existing `git.spawns` counters and Git Trace2 counts remain separately labelled; they are not
  interchangeable. Frozen enterprise transports can intentionally omit Trace2 environment values.
- Local bare remotes isolate process, filesystem and validation cost. They do not measure office
  proxy/DNS/credential latency, endpoint-security scanning attribution, or native Copilot turns.
- The workspace safety suite exercises destructive-action refusal, quarantine, recovery, and many
  independent clones. Its total duration is not one workspace or Story creation time. Run each
  file once; a negative `--test-name-pattern` is not a safe way to partition nested test groups.

## Safety and regression coverage

The full native workspace and clone-resume suites retain dirty/unpushed work, index flags, recovery
records, colliding targets and actual Windows directory locks. Fingerprint tests independently
reconstruct the old two-read manifest and require the same hash for ordinary, flagged, sparse and
conflicted indexes. AST tests cover deferred budgets, launch failures, revision changes and real
background completion. Intake receipt, ledger and activation tests preserve fresh authority/CAS,
symbolic-ref refusal and remote-state precedence. Checks, VS Code typechecking and builds accompany
native Mac and Windows measurements; platform-only cases are reported explicitly, not called passes.

The intake benchmark additionally exercises the editor-equivalent selected-base branch-folder
path, issues a genuine receipt and passes its exact returned repository path and receipt to
isolated Story start. It reports preview, start, combined latency and prewarm separately, using
private workspace registries, runtime/configuration caches and local remotes.

Large fixtures are seeded with a bounded `git fast-import` pack, retaining distinct file contents,
then an index-only `read-tree`. Setup refuses repositories with existing refs. This avoids tens of
thousands of loose-object writes and Windows antivirus/fsync delays before measurement; it does
not bypass or time-exclude any part of the measured clone, readiness, validation or publication.
Baseline and candidate use the same packed fixture profile. All comparisons must be rerun after
changing this profile; loose-object and packed-object results are not pooled.

On Windows, freshly created configuration pools receive protected current-user-only ACLs.
Git's successful filtered-fetch/seal can replace `config` via `config.lock`; that replacement must
prove bounded inert bytes and a unique regular inode before protection is restored. Existing
unqualified pools and failed transfers are never implicitly repaired, and final ACL validation
remains strict. Closed decline categories distinguish ACL, path, access and other storage failures
without retaining filenames, URLs or exception messages in metrics.
