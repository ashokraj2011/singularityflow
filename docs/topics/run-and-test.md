---
id: run-and-test
title: Run the application and its tests from a capability
aliases:
  - run-app
  - app
  - local-integration
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

## Use it from each surface

- **Shell:** `singularity-flow app plan`, `singularity-flow app start [ID] [--environment ENV]`, `singularity-flow app status`, `singularity-flow app stop [ID]`; `singularity-flow tests run [--command ID] [--environment ENV]` and `singularity-flow tests summary`.
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

## Troubleshooting

- If `app start` says the policy is off, the capability's `localIntegrationEvidence` must become `allowed` through a capability proposal; nothing ran.
- If it says an environment is not bound, bind it with `env bind <ENV> --stdin` and retry.
- If it says the entry was not ready in time, check the URL and readiness rule in `app plan`; the process tree was stopped.
- If it says the entry is already running, stop it with `app stop` first.

## Related topics

Continue with `sflow explain environment-bindings` and `sflow explain capability-management`. See `docs/SPEC-RUN-AND-TEST-v1.md` for the contract.
