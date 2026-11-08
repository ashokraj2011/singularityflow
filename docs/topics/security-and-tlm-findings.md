---
id: security-and-tlm-findings
title: Security and TLM findings
aliases:
  - security-findings
  - tlm
  - findings-workbook
  - technology-lifecycle
questions:
  - How do I give SFlow the security team's findings?
  - What format is the findings workbook?
  - Which columns does the TLM sheet need?
  - Our sheet uses other headers; how do I map them?
keywords:
  - excel
  - xlsx
  - csv
  - workbook
  - security team
  - end of life
  - findings template
commands:
  - findings
related:
  - findings
  - starting-work
  - configuration
version: 1
---
The security team and the technology lifecycle (TLM) owners give SFlow their lists as one Excel workbook in SFlow's format, or as one CSV file per list. Later the same rows come from the security team's URL; both land in one register.

## Purpose and prerequisites

Use this topic to get the workbook template and to see what each column means. Nothing needs installing: SFlow reads `.xlsx` and `.csv` itself.

## Use it from each surface

- **Shell:** `sflow findings template --out FILE` writes an empty workbook with a `Security` sheet and a `TLM` sheet, the headers and one made-up example row on each. It never overwrites a file.
- **Copilot:** `/sf-findings` runs the same commands.
- **VS Code:** the Findings view lists the register.

## Guided workflow

1. Write the template: `sflow findings template --out findings.xlsx`.
2. The security team fills in the `Security` sheet and the TLM owners the `TLM` sheet, one row per finding or component.

## The workbook

The first row of each sheet holds the headers. A header is matched by name without regard to case, spaces or punctuation, and common other names are understood (`Ticket` for ID, `Risk` for Severity, `Repo` for Repository, `EOL` for End of life date). Either sheet may be absent. A single sheet or a CSV file is read as the list `--feed security|tlm` names.

**Security** (required: ID, Title, Severity, Repository): Type (Code, Dependency, Configuration, Container), File, Line, Package, Installed version, Fixed version, CVE, CWE, Rule, Tool, Description, Due date, Status (Open, In progress, Accepted risk, False positive, Fixed), Exception expiry, Owner. Severity is Critical, High, Medium, Low or Info.

**TLM** (required: ID, Component, Repository, Target version): Ecosystem (npm, maven, gradle, pypi, nuget, go, runtime, container, os), Current version, End of life date, Due date, Status (Open, In progress, Waiver, Done), Waiver expiry, Owner, Notes.

Dates are ISO dates (`2026-12-31`) or Excel date cells. Repository is a repository name (`payments-api`), `owner/name`, or its URL, and matches the Story's repository. An ID is up to 80 letters, digits or `. _ : # / -`, with no spaces or commas.

## Other headers

A team whose sheet uses other headers maps them in `singularity/findings.yml`, so no code changes:

```yaml
schemaVersion: 1
security:
  sources:
    - { id: security-team, type: upload, columns: { id: Ticket, severity: Risk, dueAt: SLA } }
```

The keys are the column names above in camel case (`id`, `title`, `severity`, `repository`, `installedVersion`, `dueAt`, `exceptionExpiresAt`, `component`, `targetVersion`, `endOfLifeAt`, `waiverExpiresAt`, ...). A file that cannot be read is reported and the built-in names apply.

## State and safety

Cell text is data. It is bounded, its control characters are dropped, anything that looks like a secret is redacted, and it is quoted wherever it is shown. It is never read as an instruction and never put into a URL. A workbook is read with limits on its size and on each part it unzips; formulas are never evaluated, only the value Excel saved with them.

## Troubleshooting

- **`FINDINGS_WORKBOOK_UNREADABLE`:** the file is not an `.xlsx` workbook or a CSV file, or it is larger than the limits. Save it again from Excel as `.xlsx`, or export the sheet as CSV.
- **`FINDINGS_OUTPUT_EXISTS`:** `findings template` found a file at `--out`; name another file.

## Related topics

- `findings` — the code step's own findings from scanners, and the refusal codes.
- `starting-work` — starting a Story.
