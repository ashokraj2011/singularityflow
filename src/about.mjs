import { VERSION } from './version.mjs';

export const ABOUT = `Singularity Flow ${VERSION}

Singularity Flow is a Git-native, configurable SDLC orchestration system for
GitHub Copilot and engineering teams. It belongs to the Singularity product
brand and uses the short, collision-safe sflow- command namespace.

What it provides:
  - YAML-defined feature, bugfix, chore, Figma-mobile, and custom workflows
  - Session governed agents, phase-aware prompts, and repository world-model grounding
  - Configurable artifact templates, phase inputs, approvals, and quality gates
  - Jira or manual intake with supporting documents
  - Requirements-to-code traceability, verification, and conformance reporting
  - Atomic Git commit/push state transfer, including every approval decision
  - Remote Markdown agents and a VS Code configuration experience
  - Per-phase token and model usage reporting when the provider exposes it
  - A redacted, machine-local activity log readable from the CLI and Copilot

Command namespace:
  Copilot: /sf-<action>        Example: /sf-start, /sf-next, /sf-about
  Terminal: sflow-<action>     Example: sflow-next, sflow-about
  Compatibility: singularity-flow <action>

Workflow state lives in committed work-item branches, so another person or
terminal can fetch the branch and continue without a separate workflow database.

Run /sf-help in Copilot or singularity-flow help in a terminal for the full guide.`;
