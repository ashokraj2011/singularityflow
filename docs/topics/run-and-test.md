---
id: run-and-test
title: Run the application and its tests from a capability
aliases:
  - run-app
  - app
  - local-integration
  - debug-app
  - run-configurations
  - run-configuration-types
related:
  - environment-bindings
  - capability-management
commands:
  - app
  - tests
version: 13
---
A delivery capability can say how its application starts and which quality commands are its tests, in `singularity/capabilities.yml`. VS Code, Copilot and the Shell then start it, check it and stop it with the same model-free commands, and a person never has to guess a dev command or paste a value.

## Purpose and prerequisites

Use this topic when you want to run a capability's application on your machine, against one of its declared environments (`dev`, `qa`, `uat`, …). The start entries live under `application.start` of the delivery capability and change through the reviewed capability proposal like any other capability field. Each entry is a shell-free argv, a repository-relative working directory, a loopback URL (`127.0.0.1`, `localhost` or `[::1]`) and a readiness rule (`ready: { http: /path }` or `ready: { log: "text" }`, with `timeoutMs` from 1,000 to 600,000).

An entry may list `environments` from `singularity/environments.yml`; the first is the default. Their values are given to the started process only, and only when the capability policy `localIntegrationEvidence` is `allowed`. With the policy `off` (the default) such an entry is refused before anything runs.

## IDE-style run configurations

Start entries follow the run configurations people already keep in IntelliJ, PyCharm, WebStorm, GoLand, Rider and VS Code.

- **Arguments per environment.** `arguments: { dev: [-Dspring-boot.run.profiles=dev], qa: [...] }` appends a list (1 to 64 shell-free strings) to `argv` for that environment only; each key must be one of the entry's `environments`. `app plan` shows the resolved argv per environment, and the command identity (`commandSha256`) covers it, so a changed argument asks for confirmation again. A long or machine-specific option set may live in an argument file in a `localFiles` folder, for example `java @resources/dev/jvm.args`.
- **Debug start.** `debug: { runtime: java|python|node|go|dotnet, port, suspend }` (ports default to java 5005, python 5678, node 9229, go 2345; `suspend` is for java and node). `singularity-flow app start <ID> --debug` adds the runtime's debugger on `127.0.0.1` only: the JDWP agent after `java`, merged into Maven's `-Dspring-boot.run.jvmArguments`, or added to Gradle's `bootRun`/`run` task by a private init script (Gradle's own `--debug-jvm` is refused: it binds every interface); `python -m debugpy --listen 127.0.0.1:PORT` before the script or module (`uvicorn` and other console scripts run as their module, Django's `runserver` gets `--noreload`); `--inspect=127.0.0.1:PORT` after `node`, or npm's own `node-options` setting for `npm`, `npx` and `pnpm` scripts so the debugger reaches the application and not the package manager (`yarn` is refused); `dlv debug … --headless --listen=127.0.0.1:PORT` for `go run`; nothing for `dotnet`, whose pid `app status` reports for attaching. It prints `Debugger listening at 127.0.0.1:<port>` once the port accepts, then waits for readiness as usual; `app status` reports `debug: { runtime, port, listening }`. An entry may instead give `debug.argv` (a full replacement), `debug.arguments` (appended) or `debug.environment` (only `NODE_OPTIONS`, `JAVA_TOOL_OPTIONS` or `JDK_JAVA_OPTIONS`, set to the debugger flag alone). Every debug address must be loopback: `0.0.0.0`, `*`, `::` or another host anywhere in the debug arguments is refused when the map is read.
- **Suggestions.** `singularity-flow app suggest [--json]` reads JetBrains `.run/*.run.xml` and `.idea/runConfigurations/*.xml` (Application, Spring Boot, Maven, Gradle, Python, Django server, Node.js, npm, Go, Rider), VS Code `.vscode/launch.json` (with comments), .NET `Properties/launchSettings.json`, and the platform's own markers where no configuration covers a directory (package.json scripts, the Spring Boot Maven or Gradle plugin, `manage.py`, a FastAPI app, a Go `main` package, an ASP.NET project). IDE-only launches become build-tool launches that run from a terminal (an IntelliJ Spring Boot configuration becomes the Maven or Gradle run, a WebStorm npm configuration `npm run <script>`), configurations that differ only by environment become one entry with `arguments` per declared environment, and the URL and readiness are guessed (`/actuator/health` when Spring Boot Actuator is a dependency). Variables become environments.yml names: a name or value that looks secret becomes a `secret` name with no value, and a secret on the command line is removed and named instead. Nothing is written: the output carries an `applicationDraft` for `singularity-flow capability set <ID> --application-file <FILE>` (or `capability edit <ID> --lead <URL> --application-file <FILE> --mode set` for a proposal) and an `environmentsDraft` for the configuration proposal.

## Run configuration types

A start entry may be typed, as IntelliJ, PyCharm, WebStorm, GoLand and Rider type a run configuration: `type` names how it starts and the type's own fields replace `argv`. An entry without `type` (or with `type: command`) is the command line it always was and runs, and is identified, exactly as before.

| Type | Fields | Runs as |
|---|---|---|
| `spring-boot` | `launcher` (maven \| gradle), `mainClass`, `vmOptions`, `programArguments`, `activeProfiles` | Maven `spring-boot:run` with `-Dspring-boot.run.main-class`, `.jvmArguments`, `.arguments`, `.profiles`; Gradle `bootRun` with `--args`, the JVM options, profiles and main class going to the task through a private init script |
| `jar` | `jar`, `vmOptions`, `programArguments` | `java <vmOptions> -jar <jar> <programArguments>` |
| `application` | `launcher` (maven-exec \| gradle-run), `mainClass` (required for maven-exec), `vmOptions`, `programArguments` | `mvn -q compile exec:java -Dexec.mainClass=… [-Dexec.args=…]` with the VM options in `MAVEN_OPTS`; or Gradle `run` through the private init script |
| `maven` / `gradle` | `goals` or `tasks`, `profiles` (maven), `properties`, `arguments` | the wrapper when present, else `mvn` / `gradle`: `<goals> -P<profiles> -D<k>=<v> <arguments>` (gradle: `-P<k>=<v>`) |
| `python` | `script` or `module`, `interpreter`, `interpreterOptions`, `parameters` | `<interpreter> <interpreterOptions> <script \| -m module> <parameters>` |
| `django` | `manage`, `host`, `port`, `settings`, `noReload`, `interpreter`, `interpreterOptions`, `parameters` | `<python> manage.py runserver 127.0.0.1:<port> [--noreload] [--settings=…]` |
| `fastapi` / `flask` | `app`, `host`, `port`, `reload`, `interpreter`, `interpreterOptions`, `parameters` | `<python> -m uvicorn <app> --host 127.0.0.1 --port <port>`; `<python> -m flask --app <app> run --host 127.0.0.1 --port <port>` |
| `node` | `script`, `nodeOptions`, `applicationParameters`, `nodeInterpreter` | `node <nodeOptions> <script> <applicationParameters>` |
| `npm` | `packageManager` (npm \| pnpm \| yarn), `script`, `arguments` | `npm run <script> -- <arguments>`; pnpm and yarn pass the arguments after the script name without `--` |
| `go` | `kind` (package \| file \| directory), `target`, `goToolArguments`, `programArguments` | `go run <goToolArguments> <target> <programArguments>` |
| `dotnet` | `project`, `launchProfile`, `configuration`, `arguments` | `dotnet run [--project …] [--launch-profile …] [-c …] -- <arguments>` |
| `command` | `argv` | as written |

```yaml
start:
  - id: api
    name: Api
    type: spring-boot
    launcher: maven
    mainClass: com.example.api.ApiApplication
    vmOptions: [-Xmx1g, -Dfile.encoding=UTF-8]
    programArguments: [--server.port=8080]
    activeProfiles: [dev]
    workingDirectory: services/api
    env: { FEATURE_FLAGS: "a,b" }
    beforeLaunch:
      - argv: [../../mvnw, -q, compile]
    environments: [dev, qa]
    perEnvironment:
      qa: { activeProfiles: [qa], vmOptions: [-Xmx2g] }
    url: http://127.0.0.1:8080/
    ready: { http: /actuator/health, timeoutMs: 180000 }
    debug: { port: 5005 }
  - id: web
    type: npm
    script: dev
    arguments: [--host, 127.0.0.1, --port, "5173"]
    workingDirectory: apps/web
    url: http://127.0.0.1:5173/
    ready: { http: / }
```

- **Defaults.** `name` defaults to the id. The Maven or Gradle wrapper nearest the working directory is used (`./mvnw`, `../../gradlew`), else `mvn` or `gradle`; a Java entry's launcher follows its nearest build file. The interpreter is the project's `.venv/bin/python` (or `venv`) nearest the working directory, else `python3`. `packageManager` follows the nearest lock file, else npm. `host` and `port` follow the entry's `url`. A go entry runs the working directory's package unless it names a target.
- **Paths** in fields (`jar`, `script`, `manage`, `project`, a repository `interpreter`, a go file or directory) are repository-relative like `workingDirectory`, without `..`; the command line names them from the working directory. An interpreter outside the repository is machine-specific and is refused.
- **`env`** sets literal variables for the application only. Names are UPPER_CASE and not reserved (`PATH`, `HOME`, `NODE_*`, `GIT_*`, proxies and the like are refused), and a name or value that looks like a secret is refused: secrets stay in `environments.yml` and are bound with `env bind`. A value bound for the chosen environment wins over a literal of the same name. Argument lists and properties are checked the same way: `-Ddb.password=…` is refused, `-Ddb.password=${DB_PASSWORD}` (read from the environment at run time) is not.
- **`beforeLaunch`** lists up to 8 steps, each `{ argv, workingDirectory?, timeoutMs? }` (timeout 1,000 to 1,800,000 ms, default 600,000). They run in order, like IntelliJ's "Before launch", with the application's environment and the same output redaction; a step that fails or times out stops the start and the application never runs.
- **Precedence per environment.** `perEnvironment.<ENV>` may override the type's fields, `env` and `beforeLaunch`: its fields replace the base ones (a list replaces the whole list, so an empty list means none in that environment), its `env` is added on top of the base `env` by name (the environment's value wins) and its `beforeLaunch` replaces the base steps. The environment's `arguments` (the map) are then appended last. A `command` entry varies per environment with `arguments.<ENV>`, as before; its `perEnvironment.<ENV>` may also replace `argv`, add `env` or replace `beforeLaunch`. For `maven`, `gradle`, `npm` and `dotnet`, `arguments` written as a list is the type's own field; written as a map it is the per-environment arguments. Maven `properties` and Gradle `properties` map a name to a value (`-Dname=value`, `-Pname=value`); Gradle has no `profiles`.
- **Identity.** `commandSha256` covers the resolved form of every environment (argv, variables, steps and the private files' content), so changing any field asks for confirmation again. `app plan` shows `type`, `name`, `fields` and, per environment, `resolved: { argv, envNames, beforeLaunch }`.
- **Debug.** `debug: { port }` takes its runtime from the type, and the debugger goes where the type keeps its options: the JDWP agent into the VM options (Maven `jvmArguments`, the Gradle init script, the `java` line, or `MAVEN_OPTS` for exec:java); `-m debugpy --listen 127.0.0.1:PORT` after the interpreter options (Django gets `--noreload`, uvicorn and flask lose `--reload`); `--inspect` after `node`; npm's `node-options`; `dlv` for go; the pid for dotnet.
- **Preview.** `singularity-flow app config preview --application-file <FILE> [--capability ID] [--json]` checks a whole application block and returns, per entry, each environment's resolved command line (`environments: [{ name, default, resolved: { argv, envNames, beforeLaunch } }]`) or every error as `{ path, message }` with its block path (`start[1].vmOptions`, `start[0].perEnvironment.qa.activeProfiles`), as IntelliJ shows "Command line" in its run configuration dialog. A refused block carries the same `errors` in the refusal's `error.details`. `app plan --json` also returns `application`, the block exactly as `capabilities.yml` holds it (an empty `{ start: [], tests: [] }` when there is none), so an editor can write the whole block back without dropping `tests`. Nothing runs and nothing is written; write the block with `capability set <ID> --application-file <FILE>` or propose it with `capability edit <ID> --lead <URL> --application-file <FILE> --mode set`, which refuse a typed field error before writing.
- **Suggestions are typed.** `app suggest` drafts an IntelliJ Spring Boot configuration as `type: spring-boot` with its own fields, a PyCharm FastAPI configuration as `type: fastapi`, a WebStorm npm configuration as `type: npm`, and so on, with per-environment differences under `perEnvironment`; `start.argv` shows the command line each resolves to.

## Use it from each surface

- **Shell:** `singularity-flow app plan`, `singularity-flow app start [ID] [--environment ENV] [--debug]`, `singularity-flow app status`, `singularity-flow app stop [ID]`, `singularity-flow app suggest`, `singularity-flow app config preview --application-file <FILE>`; `singularity-flow tests plan`, `singularity-flow tests run [--command ID] [--environment ENV]`, `singularity-flow tests summary`, and `singularity-flow tests base --work-id ID`, which says whether a Story's failures also fail on its base commit (see test-recovery).
- **VS Code:** the capability page runs `app start` as a task, reads `app status --json`, and opens the test summary from `tests summary --json`. Its Tests section and each run's confirmation say the plan in words, what was seen and not used, and what to do before starting.
- **Copilot:** run `app plan`, `app start` and `tests run` instead of guessing a command; Copilot never runs `env bind`. At a code step it reads `recovery.testExecution.earlyChecks`.

## The test plan, in words

`singularity-flow tests plan [--work-id ID] [--json]` says what SFlow will run and runs nothing. For each suite: the command, where it runs, where it was found or who approved it (`why`, `source`), whether results are read per test or as counts (`results`), and what it covers. Beside the suites:

- `paths`: which suite covers each file changed so far, else each file the plan names, and which have no suite.
- `notUsed`: what SFlow saw and does not run, such as a Playwright suite a configured `npm test` hides, or a runner it has no reader for.
- `earlyChecks`: what would otherwise surface at the end of the step. Each is `{ id, words, action }`. None of them refuses; only the gates refuse.
- `pin`, on each suite of a Story: whether it changed since it was pinned for this Story, in words (`not-pinned`, `unchanged`, `changed`, `accepted`, `restored`). A `changed` one shows before and after and the request to make, before a gate refuses it.

The early checks start no test and download nothing. `dependencies-not-installed` and `runner-not-installed` name the install command the lockfile implies. `planned-runner-missing` says when the plan names a browser test and the package has no browser runner yet, and what adding one costs. `runner-collects-other-tests` says when Vitest or Jest would collect a Playwright spec, which fails that run even when each of its own tests passes. `node-version` compares `.nvmrc`, `.node-version` and `engines.node` with the Node here, and names the known case where Node 25 or later breaks Vitest's DOM environment for code that uses `localStorage`. `browser-not-installed` and `tool-not-found` name what is missing from this machine. A check that cannot read what it needs says nothing, so a line is always something seen here; no line does not prove a run will pass.

A pin binds what can select its command's tests: its script chain and the configuration of the runners it reaches, so changing `playwright.config.js` no longer refuses a Vitest command. A script SFlow cannot follow keeps every configuration pinned, and a pin recorded under earlier rules keeps them until a person's re-pin. A changed file no plan names stays out of the run, so its pin reads the file as the run sees it, at the last commit.

Files that changed together for how tests run (a runner's configuration or setup file, with the manifest and lockfile beside it) are one decision on the decision list and in the convergence table: one row, one reason, and each file is still recorded by name. A manifest and lockfile alone are not grouped, and a test or application source never is.

Beside the runners above: PHPUnit runs when `phpunit.xml` or a Composer dependency names it, with `--log-junit`. `bun test` in a package script gets `--reporter=junit`. A `deno.json` runs `deno test`, or its own `test` task, with `--junit-path`; name a test `x.test.ts` or put it in a test folder, as `x_test.ts` beside the source counts as product source. Each reports counts, so a criterion rests on the whole suite. RSpec, minitest, Bazel, cargo and Nx's `@nx/vite:test` are proposals: setup and the refusal show the command and what a person must add or choose (a formatter gem, the targets, stable cargo's flag or nextest), and nothing runs until a person approves it. `@nx/vite:test` stays a proposal until a real Nx proves it hands Vitest its report options.

A failed run may not be the Story's: `singularity-flow tests base --work-id ID` compares it with the Story's base commit (see test-recovery). A gate never starts it. A refused publication names it, and VS Code's Test summary page offers it as a button on a failed run.

A path a script now names is compared with the test files of the base commit. A file the base's own runner configuration never collected (`test.include`, `testMatch`, `roots`, `testDir`, `spec`, `testpaths`, read as plain values and never run) was never there to drop. A configuration SFlow cannot read that way stays a person's decision, and the refusal says it may be why.

With nothing changed yet and nothing to run at the repository root, a Story's plan shows what the plan's own files will resolve to, as `prospective: true`. A refusal that resolving the commands would give is `stopped`, in words, rather than an error.

## Guided workflow

1. Run `singularity-flow app plan` to see each start entry and whether its environments are bound.
2. Bind a missing environment from your own secret helper: `your-approved-secret-helper --format sflow-env-json qa | singularity-flow env bind qa --stdin`.
3. Run `singularity-flow app start web --environment qa`. It prints `Ready at <url>` when the URL answers below 500 (or the log text appears), and stops the whole process tree if it does not become ready in time.
4. Check it with `singularity-flow app status`, and stop it with Ctrl+C or `singularity-flow app stop web`.
5. Run the tests with `singularity-flow tests run` (the code step's commands, or the capability's `application.tests`), then read every test case with `singularity-flow tests summary`. A failed case carries `message`, its short failure message (about 2,000 characters at most, redacted like the run's output when an environment was bound): the JUnit `<failure>`/`<error>` message and its first lines, the node:test error, or Jest's and Vitest's `failureMessages`; it is null when the report gives none, and passing cases carry none. The text summary, the VS Code Test summary page and `/sf-test` show it under the case. With `--work-id` the run is staged for that Story step instead; a passing one stands for the step's next publication while nothing it ran on changes. For a Story step, `tests summary` shows the run bound to the step, with the runs it reused from an earlier step merged in, and names a newer run it did not bind; `--latest` shows the newest run.

## State and safety

A capability-scope `tests run` is a local preview: it is kept at `singularity-flow/test-runs/<capability>/<RUN-ID>.json` below the Git common directory (the last 20 runs) and is never evidence for a Story. A Story-scope run stages attempts for the step like publication preflight; they are admitted with the step's next publication or submission and labelled as local runs. A passing one also stands for that publication while the code, the command and the environment are the same, so the tests are not run again (see "When tests do not run again" in `singularity-flow explain test-recovery`). A run given an environment's values does not.

`app start` keeps a private run record (pid, URL, start time and command identity) under the Git common directory at `singularity-flow/app/<capability>/<id>.json`, readable by you only. `app stop` stops only a process tree that record names, after checking the process is still the one that was started. Values never go into argv, a file, the worktree, the run record or any output: every bound secret of four or more characters is shown as `[redacted:NAME]`.

A test command linked to an environment (through `checks` in `environments.yml`, its own `environment` field, or `application.tests[].environments`) runs with that environment's values only when the policy is `allowed` and the binding is complete. Publication and submission then record it as `local-integration`, labelled "Local integration run by <identity>, environment `qa`, commit `<abc1234>`; values never recorded". When `checks` links the command to one environment, only a run in that environment counts for the step; a run in another is shown with "does not count for this step: it requires `qa`". With the policy `off` such a command stays blocked, and the refusal names the policy and its capability proposal.

Every command SFlow runs for a repository (a gate's tests and builds, `tests run`, a before-launch build and the application, readiness and recovery runs) uses the Node version the repository asks for: the nearest `.nvmrc`, then `.node-version`, from the command's working folder up to the repository root. nvm does not load in these runs, because it is a shell function and they start without a shell. When the `node` on PATH already matches, nothing changes. Otherwise the highest matching Node from nvm, fnm, Volta, asdf, mise, nodenv, n or Homebrew goes first on that run's PATH and SFlow says which one. A test attempt records the outcome in `environment.nodeVersion`. SFlow never installs a Node.

## Troubleshooting

- If a run says `.nvmrc asks for Node 18, and no installed Node matches`, it ran on the Node PATH found. Install that version with your version manager (`nvm install 18`) and run again; if the run failed before any test ran, it reads as `toolchain-version`.
- If `app start` says the policy is off, the capability's `localIntegrationEvidence` must become `allowed` through a capability proposal; nothing ran.
- If it says an environment is not bound, bind it with `env bind <ENV> --stdin` and retry.
- If it says the entry was not ready in time, check the URL and readiness rule in `app plan`; the process tree was stopped.
- If it says the entry is already running, stop it with `app stop` first.
- If `app start --debug` says debugpy or dlv is missing, install it yourself with the command it names (`pip install debugpy`, or Delve), then retry; if it says the debug port is in use, stop what listens there or set `debug.port`.
- If `app plan` or `app start` names a field (`Capability 'web'.application start[0].vmOptions …`), fix that field; `app config preview --application-file <FILE>` lists every error at once.
- If `app start` says a before-launch step exited or did not finish, the application did not start; run the step yourself to see why, or raise its `timeoutMs`.
- If `app suggest` skips a configuration, its note says why: a path outside the repository, an IDE-only macro such as `$USER_HOME$`, a type it does not translate, or a file that is malformed or larger than 256 KiB.

## Related topics

Continue with `sflow explain environment-bindings` and `sflow explain capability-management`. See `docs/SPEC-RUN-AND-TEST-v1.md` for the contract.
