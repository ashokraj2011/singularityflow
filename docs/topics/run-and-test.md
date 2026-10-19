---
id: run-and-test
title: Run the application and its tests from a capability
aliases:
  - run-app
  - app
  - local-integration
  - debug-app
  - run-configurations
related:
  - environment-bindings
  - capability-management
commands:
  - app
  - tests
version: 1
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

## Use it from each surface

- **Shell:** `singularity-flow app plan`, `singularity-flow app start [ID] [--environment ENV] [--debug]`, `singularity-flow app status`, `singularity-flow app stop [ID]`, `singularity-flow app suggest`; `singularity-flow tests plan`, `singularity-flow tests run [--command ID] [--environment ENV]` and `singularity-flow tests summary`.
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
- If `app suggest` skips a configuration, its note says why: a path outside the repository, an IDE-only macro such as `$USER_HOME$`, a type it does not translate, or a file that is malformed or larger than 256 KiB.

## Related topics

Continue with `sflow explain environment-bindings` and `sflow explain capability-management`. See `docs/SPEC-RUN-AND-TEST-v1.md` for the contract.
