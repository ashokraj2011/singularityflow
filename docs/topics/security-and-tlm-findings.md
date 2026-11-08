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
  - Where does SFlow keep the imported findings?
  - Why did my import stay on this computer?
  - How does a Story address a security finding or TLM item?
  - How do I open a remediation Story for security findings or TLM items?
  - When does an item close?
  - How do I tell the security team what was fixed?
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
version: 5
---
The security team and the technology lifecycle (TLM) owners give SFlow their lists as one Excel workbook in SFlow's format, or as one CSV file per list. Later the same rows come from the security team's URL; both land in one register.

## Purpose and prerequisites

Use this topic to get the workbook template and to see what each column means. Nothing needs installing: SFlow reads `.xlsx` and `.csv` itself.

## Use it from each surface

- **Shell:** `sflow findings template --out FILE` writes an empty workbook with a `Security` sheet and a `TLM` sheet, the headers and one made-up example row on each. It never overwrites a file. `sflow findings import FILE [--feed security|tlm] [--source NAME] [--dry-run]` reads it into the register, and `sflow findings list` shows this repository's items. `sflow start ... --address ID,...` picks items for a new Story. `sflow findings plan` previews remediation Stories and `sflow findings start <GROUP-ID>` opens one. `sflow findings report --out FILE` writes the update for the security team.
- **Copilot:** `/sf-findings` runs the same commands. `/sf-start` offers the open items, none picked, and passes the ones you pick.
- **VS Code:** the new-Story form lists the open items as tick boxes, none ticked. The Findings view lists the register.

## Guided workflow

1. Write the template: `sflow findings template --out findings.xlsx`.
2. The security team fills in the `Security` sheet and the TLM owners the `TLM` sheet, one row per finding or component.
3. Check it: `sflow findings import findings.xlsx --dry-run` shows what would be added, changed and rejected, and writes nothing.
4. Import it: `sflow findings import findings.xlsx --source security-team`. Each rejected row is listed with its sheet, row number and reason; the rest import.
5. Pick items when a Story is created: `sflow start PAY-7 ... --address SEC-1001,TLM-2001`, a tick box in VS Code's new-Story form, or a choice in `/sf-start`. Nothing is picked unless you pick it.

## At Story creation

A new Story is shown the register's open items for its repository, highest severity and nearest due date first. Each item you pick becomes a clause of the Story with its proof, and the register shows it **in a Story** with the Story's ID. An item another Story already addresses is shown with that Story and cannot be picked twice. An ID that cannot be taken (unknown, another repository's, not open) is said, and the Story still starts.

- **Security proof:** the same tool, run on the changed code, no longer reports it. A finding only the security team can rescan is recorded as fixed, awaiting rescan.
- **TLM proof:** the manifest, lockfile or runtime file shows at least the target version.
- **Both:** all existing tests run, and the build passes.

If a Story started but could not write the register, it says so and names `sflow findings link <WORK-ID> --address ID,...`.

## Remediation Stories

An item is addressed either inside a development Story or by a Story of its own, of the seeded workflow **findings-remediation** (Security and TLM remediation): findings intake (the picked items, one clause each), remediation plan (the fix per item), implementation (the code step, with its findings loop), verification (all existing tests run) and conformance. Like the other seeded workflows it is read-only; duplicate it to change it.

`sflow findings plan` previews the groups: security findings per repository by due date, at most ten a Story (`stories: { maximumFindings }` in findings.yml), and TLM items per component. `sflow findings start <GROUP-ID> [--work-id ID] [--from-branch BRANCH]` opens the Story for one group through Story start itself. A patch or minor upgrade, and a critical or high code finding with a known fix, are the code step's to make. A **major upgrade is listed for a person** in the remediation plan and is never made by itself. The Story's Auto flight to a tested Candidate is planned with `sflow auto plan --story <WORK-ID>`, which a person confirms; a person approves the Candidate.

A repository initialized before this build has no findings-remediation workflow until its configuration is refreshed (`/sf-refresh-configuration`).

## When an item closes

When a Story that addresses items has closed, the next import moves them on. A TLM item closes when the default branch's manifest, lockfile or runtime file (`package.json`, `.nvmrc`, `.node-version`, a Dockerfile `FROM`, `requirements.txt`, `pyproject.toml`, `pom.xml`, `build.gradle`, `go.mod`) pins at least its target version, and is **fixed, awaiting proof** until it does. A security finding is **fixed, awaiting rescan**: it closes when the security team's next list no longer calls it open.

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

## The register

The imported rows go into the register on the SFlow state branch: `findings/security.json`, `findings/tlm.json`, and the import history `findings/imports.json`. Every developer and every Story reads the same list from the state ref their clone already has; a read never fetches. The uploaded file itself is never committed: only its normalised rows, and in the history its name, SHA-256, who imported it and when, the counts and each rejected row.

A later import from the same source replaces that source's rows. An item it no longer lists is marked **not in the latest import**, never deleted. A row whose Status says Fixed, Done or False positive closes its item; Accepted risk and Waiver are honoured until their expiry date. Items from other sources are left alone.

Each item has a state: open, in a Story (with the Story's ID), fixed awaiting proof, fixed awaiting rescan, closed, accepted risk, waiver, or not in the latest import.

The state branch can be read by anyone who can read the repository. So on a **public** repository the register stays in this clone's private local store (in the Git directory, never committed), and the import says why. A GitHub remote is asked through `gh api` (read-only, gh's own sign-in); any other remote counts as private. When that cannot be checked (gh missing, signed out or offline), or the state branch cannot be written, the register stays local this time and the import says so; the next import that can publish carries it.

## The update for the security team

`sflow findings report [--out FILE]` writes the update in the same workbook format: both sheets, every column, and three more: **SFlow state**, **Story** (the Story that addresses the item) and **Evidence** (the proof, such as `.nvmrc pins 22.4.1` on the default branch), with the date of the last change. Items whose Story has closed move on first, and the register is written, so the report and the register agree. **A person sends it.** SFlow never sends anything by itself. It never overwrites a file. The report imports again as the team's own sheet; its extra columns are left unused.

## State and safety

Cell text is data. It is bounded, its control characters are dropped, anything that looks like a secret is redacted, and it is quoted wherever it is shown. It is never read as an instruction and never put into a URL. A workbook is read with limits on its size and on each part it unzips; formulas are never evaluated, only the value Excel saved with them.

## Troubleshooting

- **`FINDINGS_WORKBOOK_UNREADABLE`:** the file is not an `.xlsx` workbook or a CSV file, or it is larger than the limits. Save it again from Excel as `.xlsx`, or export the sheet as CSV.
- **`FINDINGS_OUTPUT_EXISTS`:** `findings template` found a file at `--out`; name another file.
- **A row was rejected:** the import names its sheet, row number and reason (an empty required column, a Severity or Status it does not know, a date that is not ISO or an Excel date, an ID repeated). Fix the row and import again; the rest are already in.
- **"No sheet was read":** name the sheets `Security` and `TLM`, or pass `--feed security|tlm` for a single sheet or a CSV file.
- **"kept on this computer":** the import says why: the repository is public, has no remote, its visibility could not be checked, or the state branch could not be written.

## Related topics

- `findings` — the code step's own findings from scanners, and the refusal codes.
- `starting-work` — starting a Story.
