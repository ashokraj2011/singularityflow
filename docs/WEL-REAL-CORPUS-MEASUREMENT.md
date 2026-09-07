# WEL real-repository corpus measurement

Use this runner to measure the observe-only JUnit/Surefire and Jest/Vitest witness mappings on an
explicitly reviewed set of local Git repositories. It is a privacy-safe evidence-collection
boundary for WEL P0/P2. It
does not execute tests, approve a mapping, authorize a lifecycle transition, or claim that the
selected corpus was independently reviewed.

## Prepare the corpus

Run the repository's tests separately and retain a supported Jest or Vitest JSON report inside the
same repository. Then create an operator-controlled manifest outside the repositories:

```json
{
  "schema": "sflow-wel-real-corpus-input/v1",
  "cases": [
    {
      "caseId": "payments-jest-exact",
      "repository": "/absolute/path/to/payments",
      "framework": "jest",
      "workingDirectory": ".",
      "report": ".sflow/results/node-tests.json",
      "expected": {
        "outcome": "exact",
        "reason": null
      }
    }
  ]
}
```

Each expectation is a human-reviewed classification, not an instruction to the mapper. Supported
outcomes are:

- `exact` with `reason: null`;
- `inexact` with the reviewed closed WEL gap code;
- `report-refused` with `reason: "CODE_TEST_RESULT_REQUIRED"` for malformed or inadmissible
  retained reporter output.

Supported framework/report pairs are:

- `jest` with one repository-relative Jest JSON report file;
- `vitest` with one repository-relative Vitest JSON report file;
- `junit-surefire` with one repository-relative Surefire report directory. XML files are discovered
  deterministically within the bounded directory; other files are ignored and symbolic links are
  refused.

Use a distinct lower-kebab `caseId` for every case. The repository must be the exact local Git root.
`workingDirectory` and `report` must be safe repository-relative paths that already exist and do not
traverse a symlink or leave the repository.

## Run it

From a Singularity Flow source or npm-package installation:

```bash
npm run benchmark:wel:corpus -- \
  --manifest "/approved/private/wel-corpus.json" \
  --samples 3
```

The fixed bounds are 1–16 repositories, 1–64 cases, 1–20 samples per case, a 256 KiB manifest,
16 MiB per report file, 64 MiB per report selection, 1,000 Surefire XML files, and eight report
directory levels. The runner performs no network request and disables interactive Git credential
prompts.

## What it reads and emits

The runner replays retained reporter bytes through the production JUnit/Surefire or Jest/Vitest
observation and static source-identity implementation. JUnit selection uses the packaged local JDK
compiler-tree parser; Candidate tests are parsed as data and are never compiled or loaded. It reads
only the selected repository, source declarations, and reports needed for that observation. It does
not run Maven, npm, or the configured test command, and it does not invoke AST Intelligence.

The one `sflow-wel-real-corpus/v2` JSON object on standard output contains only:

- platform, architecture, and Node major version;
- repository, case, and completed-measurement counts;
- aggregate observation/CPU timing and catalog-byte distributions;
- expected and observed exact, inexact, and report-refused counts;
- false-exact, false-inconclusive, mismatch, proposal, occurrence, and closed reason counts;
- explicit labels for the selected JavaScript and JUnit observers, local JDK parser use, and the fact
  that model, AST Intelligence, network, test execution, cache writing, lifecycle authority, and
  release authority were not used.

It excludes the manifest path, repository/file paths, test names, clauses, content digests, source
or report bytes, Work IDs, Git identities, prompts, and transcripts. Before emitting output, it
rechecks `HEAD` and the complete porcelain state of every repository. Any concurrent repository
change refuses the run instead of producing a mixed observation.

An expectation mismatch emits the same content-free aggregate with `outcome: "mismatch"` and exits
nonzero. It never rewrites the manifest, report, source, Git index, or repository configuration.

## Evidence and authority boundary

The runner writes no output file. If its JSON is retained, store it only in an approved evidence
location and bind it externally to the reviewed corpus inventory and release subject. Do not add
repository identity or source content to the aggregate itself.

A green local run proves only that the selected cases matched their reviewed classifications without
an observed repository-state change. WEL completion still requires independent corpus review,
supported physical-platform evidence, the Candidate/Program/attempt join, authenticated verifier
authority, office-network/recovery exercises, and signed release receipts. The presence of a
JUnit/Surefire measurement path does not establish that a real corpus or its expectations received
independent review.

The deterministic synthetic regression and release benchmark remain:

```bash
npm run test:platform:cmp-wel
npm run benchmark:wel
```

See the [WEL pending-work roadmap](WEL-PENDING-WORK.md) for the complete acceptance contract.
