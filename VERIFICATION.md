# Verification checklist

Use this checklist for the agent-only Singularity Flow 0.9.0 development model.

## Repository initialization

- `singularity-flow init` creates `singularity/workflow.yml`, all referenced
  templates and prompts, and `.github/agents/*.agent.md` without overwriting
  edited files.
- Workflow schema version 2 rejects incompatible role-bearing configuration and
  runtime state with a recreate instruction.
- Every configured phase has exactly one default governed agent.
- Agent IDs, phase references, world-model views, template references, allowed
  tools, and protected paths validate deterministically.

## Sessions and intake

- Story start asks only for source and workflow; it never asks for an execution
  role.
- Story and initiative start activate the first phase's default agent.
- Resume and phase advancement activate the current phase's default agent.
- `/sf-agent` and `singularity-flow agent <WORK-ID> --agent <ID>` provide a local,
  audited override and create no lifecycle commit by themselves.
- A human's local profile, Git identity, GitHub identity, authority group, and
  governed agent remain distinct fields.
- Work-item selection remains explicit and synchronizes the exact remote branch.

## Prompt composition and world model

- `wm compose` combines the phase contract, Agent Markdown body, required phase
  views, agent-added views, rule-selected repository files, approved inputs,
  locked remote dependencies, and applicable evidence.
- `/sflow-show-prompt` displays the exact skill plus rendered phase prompt without
  mutating state.
- Generation records the agent ID, Agent Markdown hash, world-model manifest and
  source hashes, included files, byte limits, and rendered-prompt hash.
- `off`, `warn`, and `enforce` grounding modes produce their configured severity.
- Agent-added views never remove phase-required views.

## Lifecycle and approval

- Every generation, submission, approval, rejection, and advancement produces an
  atomic commit and normal fast-forward push.
- Push failure retains the local commit, marks publication pending, blocks later
  transitions, and is recoverable with `sync`.
- Approval authority comes only from configured human identity groups. Changing
  agents never grants authority.
- Approval records include human identity, authority group, governed agent,
  timestamp, channel, exact subject hash, decision, and self-approval warning.
- Distinct-approval thresholds count distinct normalized human identities.
- Rejection invalidates only the configured downstream dependency cone.

## Inputs, artifacts, and conformance

- Input declarations validate ordering, duplicates, work-type membership, and
  byte limits in every mode.
- `record` warns and audits; `enforce` blocks missing, unapproved, or tampered
  inputs; `off` remains inert.
- Artifact metadata records generator identity and governed agent separately.
- Final conformance maps every `AC-nnn` and `SPEC-nnn` to exact source/test
  evidence and detects a stale source/test tree.

## Remote Agent Markdown

- Only exact dependency tables in Agent Markdown are processed; prose links are
  inert.
- First trust and updates require explicit confirmation. Sync never rewrites the
  lock.
- HTTPS, redirect, byte-limit, UTF-8 Markdown, target-containment, cache reuse,
  snapshot immutability, and local-edit conflict checks are covered.
- Copilot custom-agent mappings use explicit YAML first and same-name fallback
  second; mappings affect execution context only.

## Interfaces

- CLI, `/sf-*` and `/sflow-*` skills, and VS Code show the same current
  phase, default agent, documents, approvals, and next valid action.
- The VS Code Workspaces view selects and edits local context without opening a
  new window; Lifecycle owns intake and progress; Inbox shows artifacts and
  approvals; Configuration exposes workflow/artifact and
  agent/prompt/skill/prompt-pack designers plus capabilities and world-model state.
- The capability portfolio dashboard aggregates repositories, Jira routes, open
  governed work, pending approvals, diagnostics, and world-model health without
  becoming a new state store.
- VS Code labels say “agent” only for software execution contracts;
  people are shown as contributors, reviewers, and authority members.

## Release commands

```bash
npm test
npm run check
npm run vscode:build
npm run vscode:typecheck
npm run test:vscode
npm pack --dry-run
```

Acceptance requires a clean test run, deterministic checks, a clean worktree
after packaging, and successful branch publication without force-pushes.
