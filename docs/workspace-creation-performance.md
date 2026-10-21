# Workspace creation and Story intake qualification

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
