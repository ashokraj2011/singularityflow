# Test commands and evidence (TCE) — v1

Status: owner decisions recorded 2026-10-25; phase 1 (M1–M5) then phase 2 (M6–M7) to build.

SFlow decides which tests prove a Story's code change, runs them itself and keeps the run as
evidence. That only means something when the command is the right one for the code that changed,
the run is not quietly narrowed, and the record says what actually ran. An audit of main 1ae8518b
found each of those can fail today. This spec states the model and the work to fix it.

## Owner decisions (2026-10-25)

1. **Pin guessed commands.** A test command SFlow infers is pinned for the Story the first time a
   gate runs it. A later change, including an edited script or config behind the same command,
   needs a person's approval.
2. **Narrowed runs are refused unless a person accepts.** Focused tests (`.only`), filters (`-k`,
   `--grep`, `-Dtest`, …), skipped tests and fewer tests than the Story's baseline refuse the gate
   until a step approver accepts that narrowing, with a reason.
3. **Commands in instructions are read at setup and proposed.** Test commands written in a team's
   instructions (AGENTS.md, copilot-instructions, skills, CI workflows) are read when a capability's
   tests are set up or changed, completed into full commands, and proposed for a person to approve.
4. **Order.** Phase 1 stops false evidence; phase 2 finds the right command for common setups.
   Playwright/Cypress modelling (projects, the app under test, per-test results) and the review
   screens follow in a later version.

## Owner decisions (2026-11-06)

On "sf-code generates tests and runs it, now next phases also run it": "dont rerun if the code has not
changed". Asked what weakens evidence, the owner chose:

1. **Anyone may switch a Story to fewer tests,** an agent included. The switch is recorded with its reason
   and shown to the reviewer. This covers the open setting only (M9); decision 2 above still refuses a filter or
   `.only` added to the tests themselves.
2. **On only new and changed tests, existing tests never run,** at any step, and the review says so. Amended
   2026-11-08 (`[CQF:REQ-017]`): the last step that runs tests runs once the existing tests that import changed code.
3. **A recorded `tests run` counts for publish** when its command, code and environment are the same. It
   amends the RUN M2 rule that a local run never satisfies a gate. A decision or a test-run risk still never
   reads one.

## What the audit found (main 1ae8518b)

Only SFlow's own CLI produces gate evidence (publish preflight, submit, runner epoch through
`runQualityCommand`, `src/quality-command-runner.mjs`). Commands are the pinned workflow
`qualityCommands`, accepted `decision test-command` records, and per-module inference recomputed at
every publish (`resolveDeliveryQualityCommands`, `src/delivery-evidence.mjs`; `inferModuleTestCommand`,
`src/code-delivery-tests.mjs`). Coverage is a path prefix of each passing command's `affectedRoots`.

- **Wrong coverage.** A path walks up to the nearest *recognised* build file, so a Python folder with
  only `requirements.txt`, or an Xcode project, under a root `package.json` is "covered" by `npm test`.
  The `node --test <files>` fallback runs mocha tests with the wrong runner and covers `.`.
- **Unpinned inference.** Inference is recomputed every publish; an agent may edit a package script
  (`"test": "jest src/one"`) and the gate runs the narrower suite. Suppression checks argv only.
- **Narrowing passes.** `.only` is parsed but unused; `-k`, `--grep`, `-Dtest`, `--shard`, partial
  skips and a drop in discovered tests all pass. Playwright retries count as plain passes.
- **Unclean, unrecorded runs.** Gate runs inherit the whole `process.env`; `CI` is not set;
  `MAVEN_ARGS`, `PYTEST_ADDOPTS` and similar can narrow a run invisibly; the attempt records only
  platform, arch and the CLI's Node. Test process groups have no reaper.
- **Test-run risk too broad.** A decision binds phase, command and argv plus "no test executed", so
  for up to 90 days it also covers a compile error or hang the change caused, while environment
  failures that fail every test (missing browser, refused database connection) are not eligible.
- **Instruction commands unusable.** Team import and Build with Copilot capture commands without
  `workingDirectory`, `affectedRoots` or a result adapter (and with `VAR=x` as argv[0]); pinned, they
  block publish with `CODE_TEST_RESULT_REQUIRED`. There is no way to declare a literal variable.
- **Missed ecosystems.** .NET `tests/App.Tests` beside `src/App`; mocha, Create React App, Angular
  with Jest, nested/chained scripts, `test:unit`; Playwright beyond an exact script; Cypress; Maven
  failsafe ITs (never run, module still counted covered); Python without `pyproject.toml`; Android
  device tests; Xcode at publish; cargo JSON lines.

## Model

### Test command record

The existing `qualityCommands` object form stays the record. Fields that matter here:

| Field | Meaning |
|---|---|
| `id`, `kind: test` | as today |
| `argv`, `workingDirectory`, `affectedRoots`, `timeoutMs` | as today |
| `result.adapter`, `result.path` | as today; `granularity` (`per-test` / `totals`) is derived from the adapter |
| `env` (new, phase 2) | literal non-secret variables for this command, e.g. `{ "BASE_URL": "http://localhost:3000" }`. A name that looks secret is refused and must be declared in `singularity/environments.yml` instead. |
| `provenance` (recorded, not authored) | `configured` · `story-decision` · `inferred` · `instruction`, plus the source file and line for instruction-derived proposals |
| `definition` (recorded at pin time) | the files and selectors the command resolves through, each with a sha256: the package script chain text, the module's runner config (`jest.config.*`, `vitest.config.*`, `playwright.config.*`, `pytest.ini`, `[tool.pytest]`, `tox.ini`, the pom/gradle test configuration) |

Older engines must keep reading a workflow that uses `env`: check how `normalizeExternalCommand`
treats unknown keys before adding it, and follow the existing compatibility rule for new keys.

### Sources and precedence

1. Configured (`workflow.yml` / capability), 2. Story decision (`decision test-command`),
3. Story pin (first gate use of an inferred command), 4. inference.
Inference and instruction extraction only ever **propose** outside a gate. At a gate, inference may
still fill an uncovered module, and that command is pinned on first use.

## Phase 1 — stop false evidence

### M1 Coverage truth `[TCE:REQ-050]`

- `[TCE:REQ-051]` The walk from a changed path to its module stops at a build marker of another
  ecosystem, even one SFlow cannot run: Python (`requirements*.txt`, `setup.py`, `setup.cfg`,
  `Pipfile`, `environment.yml`, `tox.ini`, `noxfile.py`), Swift/Xcode (`*.xcodeproj`,
  `*.xcworkspace`, `Package.swift`), native (`CMakeLists.txt`, `meson.build`), and the markers
  already recognised. That module is then inferred if supported, otherwise `TEST_MODULE_UNCOVERED`
  with the existing test-setup route.
- `[TCE:REQ-052]` An inferred command covers only source files of its own ecosystem: a `.py`, `.swift`,
  `.java`, `.kt`, `.cs`, `.go` or `.rs` file is never covered by an inferred Node command, and so on.
  A command a person configured or accepted keeps the roots they gave it.
- `[TCE:REQ-053]` A whole-repository inferred command (`affectedRoots: ['.']`) covers only its own
  ecosystem's files.
- `[TCE:REQ-054]` The `node --test <files>` fallback applies only when the changed tests are
  `node:test` tests; mocha, jasmine or tap test files get `TEST_MODULE_UNCOVERED` instead.

### M2 Clean, recorded runs `[TCE:REQ-030]`

- `[TCE:REQ-031]` Gate runs set `CI=1` unless the command's own environment sets `CI`.
- `[TCE:REQ-032]` Gate runs remove variables that change which tests run without appearing in argv
  (at least `MAVEN_ARGS`, `MAVEN_CONFIG`, `PYTEST_ADDOPTS`, `PYTEST_PLUGINS`, and runner selection
  variables for Jest, Vitest, Playwright and Cypress); the list lives in one module with a reason per
  name. JVM and memory options are not selection and stay.
- `[TCE:REQ-033]` The attempt records what shaped the run: `environment.ci`, the names removed, a
  digest of the declared variables (names and literal values; bound secret names only), and the
  toolchain versions of the runner family (Node and package manager, JDK and Maven/Gradle, Python and
  pytest, Go, .NET, Playwright), probed cheaply and cached per process.
- `[TCE:REQ-035]` Every command SFlow runs for a repository (a gate's tests and builds, `tests run`,
  a before-launch build and the application, readiness, recovery baselines, bisect) runs on the Node
  version the repository asks for: the nearest `.nvmrc`, then `.node-version`, from its working folder
  up to the repository root. When the `node` on PATH already matches, nothing changes; otherwise the
  highest matching Node of nvm, fnm, Volta, asdf, mise, nodenv, n or Homebrew goes first on the run's
  PATH. SFlow never installs a Node: with no match the run goes ahead on what PATH finds, says so, and
  a failed run shows the reason as `toolchain-version`. A test attempt records `environment.nodeVersion`
  (the file, the version asked for, the outcome and the version found).
- `[TCE:REQ-034]` Test process groups are registered with a reaper that ends them when the CLI exits
  or is interrupted, as Git child groups already are; a descendant holding output open no longer
  stalls a run for its whole timeout. A run that stops its command (a deadline, a cancel, a failed
  output file) reports only once nothing of the command's group is left: a descendant that holds no
  output and trapped SIGTERM, or was forked as it went out, is ended with SIGKILL once the command
  closed. Every other runner that stops a child group does the same.

### M3 Pinning `[TCE:REQ-010]`

- `[TCE:REQ-011]` The first gate run of an inferred command records a pin on the Story:
  argv, workingDirectory, affectedRoots, adapter and `definition` digests.
- `[TCE:REQ-012]` A later gate run whose inferred command for the same module differs in argv or in
  any `definition` digest is refused with `TEST_COMMAND_PIN_CHANGED`. The refusal names what changed
  and routes to a `decision test-command` request (an agent may request; a step approver accepts),
  whose acceptance replaces the pin.
  **Amended (2026-10-25):** a definition that is exactly the Story's base commit's is the team's own
  setup and is accepted with no decision, recorded as a new pin with `restoredToBase`.
  **Amended (2026-11-01):** the definition follows what the command really runs
  (src/test-command-resolution.mjs): the workspace or directory each package-manager step selects and
  that package's script chain, the configuration files a runner is told to read wherever they are in
  the repository, and a `node --test` run's `--import`/`--require` files; a named file or workspace
  that is not there is pinned as missing. Such pins carry `definitionVersion: 2`; a pin without it
  keeps the first rules for its Story, and an accepted re-pin moves it to the current rules. A suite
  the Story pinned under the current rules that its affected module no longer declares is refused as
  `removed` (TEST_COMMAND_PIN_CHANGED), unless the base commit never had it; the same `--repin`
  request, accepted by a step approver, lets it no longer run. Per-command test counts cannot see a
  missing command (review, 2026-11-01).
- `[TCE:REQ-013]` Configured and Story-decision commands also record `definition` digests at first
  run, so an edited script behind `npm test` is caught the same way.
- `[TCE:REQ-014]` Pins are replayed with the receipt, like the attempts they bind.

### M4 Narrowed runs `[TCE:REQ-020]`

- `[TCE:REQ-021]` Each gate run records `narrowing`: filter options in argv or in the pinned script
  (per runner: `-Dtest`, `-Dit.test`, `-k`, `-m`, `--grep`/`-g`, `-t`/`--testNamePattern`,
  `--testPathPattern`, `--shard`, `--only`, `--project` when not pinned), focused tests
  (`.only`, `fit`, `fdescribe`, `test.only`), skipped tests, and discovered tests below the baseline
  (the first passing run of the same pin in this Story).
  **Amended (owner, 2026-10-25):** narrowing is what the Story adds, measured against its base commit. A
  filter already in the same script there, or a focused test already in the base version of the file,
  is the team's setup: recorded as `standing`, never a reason. Skipped tests are a reason only when the
  Story's changed test files add skip markers, or a run skips more than the pin's first passing run.
- `[TCE:REQ-022]` A narrowed run refuses the gate with `CODE_TEST_NARROWED`, naming each reason.
- `[TCE:REQ-023]` A step approver may accept it:
  `decision test-narrowing [WORK-ID] --phase P --command ID --reason TEXT [--expires DATE]`. The
  decision is person-only (the Copilot guard refuses it, like `decision test-risk`), bound to the pin
  and a fingerprint of the narrowing, and covers later runs with the same or a smaller narrowing.
- `[TCE:REQ-024]` The review packet and test summary show accepted narrowing with its reason.

### M5 Test-run risk by cause `[TCE:REQ-040]`

- `[TCE:REQ-041]` Failed and blocked runs are classified: environment causes (launcher missing or not
  executable, dependency missing, registry/network/proxy, toolchain version, browser missing,
  service unreachable, Docker, permission) or code causes (compile error, syntax or import error in a
  changed file, assertion failures).
- `[TCE:REQ-042]` A test-run risk decision records the cause class it accepted, and covers a later
  run only when that run's classified cause is the same environment class. A code cause is never
  covered.
- `[TCE:REQ-043]` A run where tests executed but every failure is an environment cause (for example
  every test failed with a refused database connection) is eligible, not only "no test executed".
- `[TCE:REQ-044]` Existing decisions stay valid until they expire, but only for runs classified as an
  environment cause.

## Phase 2 — find the right command

### M6 Instructions to proposals `[TCE:REQ-060]`

- `[TCE:REQ-061]` When a capability's tests are set up or changed (`capability test-setup`, mapping a
  capability, Build with Copilot, team import), SFlow reads test commands from AGENTS.md,
  `.github/copilot-instructions.md`, `.github/instructions/*.md`, skills, CI workflows
  (`.github/workflows/*.yml` run steps), Makefile test targets, `scripts/test*` and package scripts.
- `[TCE:REQ-062]` Each candidate is completed into a full record: `VAR=x` prefixes become `env`,
  `cd dir &&` becomes `workingDirectory`, `affectedRoots` from the module of that folder, the result
  adapter and reporter arguments for its runner. A secret-looking value is never captured.
- `[TCE:REQ-063]` Candidates are shown with their source file and line through the existing test
  setup proposal; nothing is used until a person approves it. Team import and Build with Copilot
  produce complete records through the same completer.

### M7 Ecosystems `[TCE:REQ-070]`

- `[TCE:REQ-071]` Node: follow `npm run` references and `&&` chains to the runner; detect Jest, Vitest,
  mocha, Cypress, `react-scripts test`, `ng test` (Karma or Jest) and Playwright with `--project`,
  `--config` or an env prefix; add reporter arguments to the runner's own invocation, never the tail
  of a chain. Mocha reports through a JUnit reporter. Reporter arguments follow `--` for npm and bun
  only: pnpm and yarn pass `--` on, and the runner reads what follows it as test filters. A command
  never skips setup the script runs before its runner (a `pre` hook or an earlier step other than a
  lint, type or format check, a clean-up or another test run): such a script is refused with the
  test-setup route instead of guessed.
- `[TCE:REQ-072]` .NET: a product project's tests are the test projects that reference it.
  Readiness's unit-only run leaves out test projects named for integration, end-to-end, acceptance or
  functional tests.
- `[TCE:REQ-073]` Maven: a module whose POM or parent declares the failsafe plugin with an execution
  that binds `integration-test` (there or in pluginManagement) runs `verify` and reads
  `failsafe-reports` with surefire's beside it; a bare declaration binds nothing and keeps `test`, and a
  parent outside the repository counts as binding. A `verify` that wrote no `failsafe-reports` ran no
  integration tests and reads surefire's. Readiness's unit-only run uses `test`. `*IT` names are test
  files.
- `[TCE:REQ-074]` Python: `requirements*.txt`, `setup.py`, `setup.cfg`, tox, nox, uv and poetry
  projects infer pytest; pytest JUnit results are per test.
- `[TCE:REQ-075]` Android device tests, Xcode and anything needing a device or scheme are proposed,
  never guessed silently; cargo reports read JSON lines.

## Phase 3 — no reruns, and a scope that changes

### M8 Runs that still stand `[TCE:REQ-080]`

Measured on a real Story at main 74fc3317c: on one source digest the tests ran at publish, at submit and at
the later step's submit, and again on each retried publish. Conformance, approval and the final gates run none.

- `[TCE:REQ-080]` A gate reuses the latest recorded run of the same command on the same code, whichever step
  made it, when that run passed with a report that replays. Nothing is decided by a person.
- `[TCE:REQ-081]` "The same" means the application source digest, the separately hashed test inputs, program and
  arguments with the working folder and report form, the command's pin, and `environmentSha256`: `CI`, removed
  variables, declared variables, `NODE_OPTIONS` and toolchain versions. Anything else runs again, with a line
  saying why. Documentation is hashed separately and is not part of that source here or of a run's binding
  (`[CQF:REQ-011]`). A run given an environment's values, the test-recovery pilot and a runner amendment's epoch
  always run.
- `[TCE:REQ-082]` A passing `tests run` counts as such a run (owner decision 3). A `tests run` itself always runs.
- `[TCE:REQ-083]` A reused run never reads as a run of the reusing step: the check carries `reusedFrom` and the
  times of the run that happened. Publish then submit binds the one attempt; a new generation or a local run gets
  an attempt of this step and generation naming it in `reusedFrom`, so replay's binding rules did not change.
  A later non-code step's own repository run is recorded as an attempt too, so it is not repeated either.
- `[TCE:REQ-084]` An Auto flight's Candidate verification is that run when it can be. Measured on a real flight at
  main e4dbdf690: the tests ran in the Candidate's worktree and again at publication, on one source digest. The two
  were not the same run: the Candidate's had an allowlist of variables and no `CI`, ignored `.nvmrc`, kept no report,
  and chose its commands without the delivery's paths, so a test that needs an inherited variable skipped there and ran
  at publication. So each test command publication would run now runs by the gates' own kernel on the Candidate's
  worktree (the isolated run of `[E2G-027]`), in the gate's environment, and is staged as one attempt with purpose
  `candidate`. Publication and submission reuse it through `[TCE:REQ-080]`, with `reusedFrom` naming it; a
  decision or a test-run risk never reads it. The receipt, still immutable, keeps how each command ended; a quality
  command that is not a test still runs under the allowlist. Anything that differs runs again: an unequal digest (a
  file no plan names), another environment at publication, the test-recovery pilot, a command tied to an environment's
  values, a private store lost to a fresh clone. A failed Candidate run is kept like any attempt and never stands.
- `[TCE:REQ-085]` A flight's checkouts hold what the checkout that started it installed. Measured on a real flight at
  main 3477452cb: tests importing a package held only in the main checkout's ignored `node_modules` failed Candidate
  verification and the flight stopped at `repair-review-required`. Its model cannot install anything, and
  `repositoryReadiness.dependencyHydration` has reached no checkout since fb036910c. The Story's worktree found the
  package only by walking up out of `.git` into the main checkout, which also resolved a workspace package to the main
  checkout's source and not the Story's. So each flight step and each Candidate verification copies the dependency
  folders as the isolated run of `[E2G-027]` does, with links bound to that checkout's own source, and the digest, the
  environment and the Candidate's tree do not change, so `[TCE:REQ-084]` still holds. A Candidate's copy comes from the
  starting checkout and never from the Story's worktree, where the model can write. A Python virtual environment, a
  folder holding a link outside the repository, and a folder the checkout's own rules would not ignore are left out; a
  run that passes without them stands, and a failed verification names them. A dedicated clone gets nothing. No install
  runs: a flight tests with what was installed, so a Story that adds a package stops for a person. A repository can
  still configure its install as a non-test quality command, which runs there and again at publication.

### M9 A test scope that changes `[TCE:REQ-090]`

- `[TCE:REQ-090]` `story test-policy scope [WORK-ID] [--to SCOPE] [--reason TEXT]`, Copilot `/sf-test-scope`, and
  VS Code **Change which tests run** show and change the scope while the Story is open. Each change appends to
  `workflow.testScopeChanges`; a move to fewer tests needs a reason. The sealed policy and recorded runs do
  not change. The test-recovery pilot seals its own scope.
- `[TCE:REQ-091]` The intake choice reaches the gates. `resolution.testExecutionMode` was set on a local copy and
  dropped when the Story's resolution was built, so **All configured tests** was sealed and then ran the same as the
  default. New Stories pin it; a Story started before this keeps what it ran, and can change scope.
- `[TCE:REQ-092]` `new-and-changed` is a third scope, available at intake and later.
- `[TCE:REQ-093]` On it, each guessed command gets the delivery's `testPaths` (changed, carried from an
  earlier generation, or planned as existing) the way its runner takes them, as `attempt.testScope.files`.
  It is no narrowing reason: the pin stays the whole command's and its baseline is not compared. Focused tests and added
  skip markers are still reasons. A named command, a module with no new test, one with several runners, and a
  runner that cannot be told files run whole, with `attempt.testScope.whole` saying why.
- `[TCE:REQ-094]` On it a later step's `repositoryTests: run` records a note instead of running, and each step's
  review states that existing tests were not run. Amended by `[CQF:REQ-017]` (owner, 2026-11-08): the Story's last
  step that runs tests runs once the existing tests that import a changed module, and its review names them.

## Acceptance

Every milestone lands with end-to-end tests through the real CLI on fixture repositories, and each
gap above has a fixture that failed before and passes after. Fixtures: requirements-only Python and
an Xcode project under a root `package.json`; a mocha repository; a package script narrowed after the
first publish; `.only`, `-k`, `--grep` and skipped tests; `MAVEN_ARGS=-Dtest=X` in the caller's
environment; a hung grandchild holding stdout; a compile error after a test-run risk was accepted;
every test failing with a refused connection; AGENTS.md with
`BASE_URL=http://localhost:3000 npx playwright test --project=chromium`; .NET `src/App` with
`tests/App.Tests`; Maven failsafe; Create React App; Angular with Jest.
