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
version: 2
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
- **Precedence per environment.** `perEnvironment.<ENV>` may override the type's fields, `env` and `beforeLaunch`: its fields replace the base ones (a list replaces the whole list), its `env` merges by name and its `beforeLaunch` replaces the base steps. The environment's `arguments` (the map) are then appended last. For `maven`, `gradle`, `npm` and `dotnet`, `arguments` written as a list is the type's own field; written as a map it is the per-environment arguments.
- **Identity.** `commandSha256` covers the resolved form of every environment (argv, variables, steps and the private files' content), so changing any field asks for confirmation again. `app plan` shows `type`, `name`, `fields` and, per environment, `resolved: { argv, envNames, beforeLaunch }`.
- **Debug.** `debug: { port }` takes its runtime from the type, and the debugger goes where the type keeps its options: the JDWP agent into the VM options (Maven `jvmArguments`, the Gradle init script, the `java` line, or `MAVEN_OPTS` for exec:java); `-m debugpy --listen 127.0.0.1:PORT` after the interpreter options (Django gets `--noreload`, uvicorn and flask lose `--reload`); `--inspect` after `node`; npm's `node-options`; `dlv` for go; the pid for dotnet.
- **Preview.** `singularity-flow app config preview --application-file <FILE> [--json]` checks a whole application block and returns, per entry and environment, the resolved command line or every error at its field, as IntelliJ shows "Command line" in its run configuration dialog. Nothing runs and nothing is written; write the block with `capability set <ID> --application-file <FILE>` or propose it with `capability edit <ID> --lead <URL> --application-file <FILE> --mode set`, which refuse a typed field error before writing.
- **Suggestions are typed.** `app suggest` drafts an IntelliJ Spring Boot configuration as `type: spring-boot` with its own fields, a PyCharm FastAPI configuration as `type: fastapi`, a WebStorm npm configuration as `type: npm`, and so on, with per-environment differences under `perEnvironment`; `start.argv` shows the command line each resolves to.

## Use it from each surface

- **Shell:** `singularity-flow app plan`, `singularity-flow app start [ID] [--environment ENV] [--debug]`, `singularity-flow app status`, `singularity-flow app stop [ID]`, `singularity-flow app suggest`, `singularity-flow app config preview --application-file <FILE>`; `singularity-flow tests plan`, `singularity-flow tests run [--command ID] [--environment ENV]` and `singularity-flow tests summary`.
- **VS Code:** the capability page runs `app start` as a task, reads `app status --json`, and opens the test summary from `tests summary --json`.
- **Copilot:** run `app plan`, `app start` and `tests run` instead of guessing a command; Copilot never runs `env bind`.

## Guided workflow

1. Run `singularity-flow app plan` to see each start entry and whether its environments are bound.
2. Bind a missing environment from your own secret helper: `your-approved-secret-helper --format sflow-env-json qa | singularity-flow env bind qa --stdin`.
3. Run `singularity-flow app start web --environment qa`. It prints `Ready at <url>` when the URL answers below 500 (or the log text appears), and stops the whole process tree if it does not become ready in time.
4. Check it with `singularity-flow app status`, and stop it with Ctrl+C or `singularity-flow app stop web`.
5. Run the tests with `singularity-flow tests run` (the code step's commands, or the capability's `application.tests`), then read every test case with `singularity-flow tests summary`. With `--work-id` the run is staged for that Story step instead; publication and submission still run their own.

## State and safety

A capability-scope `tests run` is a local preview: it is kept at `singularity-flow/test-runs/<capability>/<RUN-ID>.json` below the Git common directory (the last 20 runs) and is never evidence for a Story. A Story-scope run stages attempts for the step like publication preflight; they are admitted with the step's next publication or submission and labelled as local runs.

`app start` keeps a private run record (pid, URL, start time and command identity) under the Git common directory at `singularity-flow/app/<capability>/<id>.json`, readable by you only. `app stop` stops only a process tree that record names, after checking the process is still the one that was started. Values never go into argv, a file, the worktree, the run record or any output: every bound secret of four or more characters is shown as `[redacted:NAME]`.

A test command linked to an environment (through `checks` in `environments.yml`, its own `environment` field, or `application.tests[].environments`) runs with that environment's values only when the policy is `allowed` and the binding is complete. Publication and submission then record it as `local-integration`, labelled "Local integration run by <identity>, environment `qa`, commit `<abc1234>`; values never recorded". When `checks` links the command to one environment, only a run in that environment counts for the step; a run in another is shown with "does not count for this step: it requires `qa`". With the policy `off` such a command stays blocked, and the refusal names the policy and its capability proposal.

## Troubleshooting

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
