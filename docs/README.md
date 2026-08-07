# Singularity Flow documentation

Singularity Flow is a Git-native delivery system with two supported product
surfaces:

- `sflow` (or `singularity-flow`) is the deterministic Node.js runtime.
- The Singularity Flow VS Code extension is the visual workspace, lifecycle,
  inbox, and configuration experience.

GitHub Copilot is the authoring surface. It runs the installed `/sf-*` skills and
governed agents; it does not own workflow state. The retired Electron application
is not part of the current product.

## Start here

| Need | Read |
|---|---|
| Install and initialize a repository | [README](../README.md) |
| Run a complete Story locally | [Local runbook](../LOCAL-RUNBOOK.md) |
| Learn the normal day-to-day flow | [How-to guide](../HOW-TO.md) |
| Understand the terms | [Glossary](GLOSSARY.md) |
| Use the VS Code extension | [VS Code guide](VS-CODE.md) |
| Create and manage workspaces | [Workspaces](../WORKSPACES.md) |
| Configure workflows, agents, prompts, skills, and templates | [Framework guide](../FRAMEWORK-GUIDE.md) |
| Look up commands and configuration keys | [Help reference](../HELP.md) |

## Architecture and governance

| Subject | Read |
|---|---|
| System components and data flow | [Architecture](../ARCHITECTURE.md) |
| Runtime internals and prompt composition | [Under the hood](UNDER-THE-HOOD.md) |
| Which state plane owns each fact | [State authority](STATE-AUTHORITY.md) |
| Approved clause-driven specification architecture | [Clause-driven specifications](CLAUSE-DRIVEN-SPECIFICATIONS.md) |
| Capability hierarchy and optional proof ledger | [Capability ledger](../CAPABILITY-LEDGER.md) |
| Validate an orphan-ledger deployment and trust tier | [Ledger deployment validation](LEDGER-DEPLOYMENT.md) |
| Epic/Initiative orchestration across repositories | [Initiative orchestration](../INITIATIVE-ORCHESTRATION.md) |
| Native Copilot handoff | [Native Copilot](../NATIVE-COPILOT.md) |
| Bounded reference previews and runtime conformance | [Harness Imports](HARNESS-IMPORTS.md) |
| Connect governed agents to MCP tools such as Playwright | [Governed MCP tools](MCP-INTEGRATION.md) |
| Pin Figma MCP metadata into approved downstream design context | [Mobile model intake](MOBILE-MODEL-INTAKE.md) |
| Measure aggregate Story delivery outcomes with privacy and quality gates | [Flow Impact Framework](FLOW-IMPACT-FRAMEWORK.md) |
| Configure people, approvals, workflows, agents, and MCP visually | [VS Code Configuration Center](CONFIGURATION-CENTER.md) |

## Operations and delivery

| Subject | Read |
|---|---|
| Test and governance checks | [Verification](../VERIFICATION.md) |
| npm and VSIX distribution | [Distribution](../DISTRIBUTION.md) |
| Security and trust boundaries | [Architecture](../ARCHITECTURE.md#security-and-trust-boundaries) |
| Historical product decisions | [Architecture decision records](adr/) |

Files named `RELEASE-*.md` are historical release records. They intentionally
describe the product at the time of that release and are not the current user
manual.

## Source-of-truth rule

Documentation explains the system, but the repository remains authoritative:

1. `singularity/workflow.yml` defines Story workflows for new work.
2. `singularity/portfolio.yml` defines Initiative profiles and repository policy.
3. `singularity/capabilities.yml` defines the organisation capability tree.
4. `.github/agents/*.agent.md` defines governed execution agents.
5. `singularity/work-items/<ID>/workflow.json` or
   `singularity/initiatives/<ID>/state.json` owns active lifecycle state.
6. Git commits and normal fast-forward pushes transfer that state between users.
