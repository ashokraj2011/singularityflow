# Documentation Map

This page classifies the Singularity Flow documentation so readers can find the
right document without scanning the full `docs/` directory.

## How To Use This Map

- Start with **Current product guides** for normal installation, workspace, Story,
  and VS Code usage.
- Use **Operations and recovery** when something is blocked, stale, interrupted,
  or slow.
- Use **Architecture and governance** to understand why the system behaves a
  certain way.
- Use **World model, AST, and token economy** for model/context behavior.
- Use **Roadmaps and specs** only when planning or validating future work.
- Use **ADRs** for durable design decisions.

## Current Product Guides

These are the first documents to share with a user or teammate.

| Document | Use it for |
|---|---|
| [README](../README.md) | Main product overview, installation, and common commands |
| [Help reference](../HELP.md) | Command and feature reference |
| [How-to guide](../HOW-TO.md) | Normal end-to-end usage |
| [Local runbook](../LOCAL-RUNBOOK.md) | Local demo or local validation path |
| [Workspaces](../WORKSPACES.md) | Creating and managing workspaces |
| [VS Code guide](VS-CODE.md) | Extension usage and panels |
| [Configuration Center](CONFIGURATION-CENTER.md) | Visual configuration for people, approvals, workflows, agents, MCP, and policies |
| [Developer Home and Story Return](DEVELOPER-HOME.md) | Returning to active work safely |
| [Golden developer journey](GOLDEN-JOURNEY.md) | Intended day-to-day journey and current product boundary |
| [Ways of Working PDF](SingularityFlow-Ways-of-Working.pdf) | Shareable user-facing guide |

## Workspace, Capability, And Onboarding

Use these for onboarding repositories, capabilities, and older workspaces.

| Document | Use it for |
|---|---|
| [Progressive capabilities](PROGRESSIVE-CAPABILITIES.md) | Starting with one simple capability and adding detail later |
| [Fast onboarding and Git performance](FAST-ONBOARDING-AND-GIT-PERFORMANCE.md) | Fast workspace attach, clone optimization, and safe Git acceleration |
| [FOS implementation plan](FOS-IMPLEMENTATION-PLAN.md) | FOS milestones, evidence, and deferred gates |
| [Capability authority discovery and workspace performance plan](CAPABILITY-AUTHORITY-DISCOVERY-AND-WORKSPACE-PERFORMANCE-PLAN.md) | Cross-laptop capability authority discovery and lead lookup performance |
| [Capability map Git robustness plan](CAPABILITY-MAP-GIT-ROBUSTNESS-PLAN.md) | Failure-safe capability mapping, proposal refs, and map repair |
| [Workspace reliability](WORKSPACE-RELIABILITY.md) | Workspace state, safety, and repair posture |
| [Existing-workspace configuration refresh](../README-REFRESH-EXISTING-WORKSPACES.md) | Refreshing old workspace configuration and state branches |
| [Reference repositories](REFERENCE-REPOSITORIES.md) | Supplying reference repositories to a Story |
| [Local reference-to-target migration](LOCAL-REFERENCE-TO-TARGET-MIGRATION.md) | Migration using a reference repository before the target repository exists |
| [Repository discovery and selection spec](SPEC-RDS-REPOSITORY-DISCOVERY-AND-SELECTION-v1.md) | Repository picker, discovery, and selection design |

## Story Lifecycle And Phase Work

Use these for Story creation, phase generation, approvals, rollback, and landing.

| Document | Use it for |
|---|---|
| [Clause-driven specifications](CLAUSE-DRIVEN-SPECIFICATIONS.md) | Requirement and acceptance-clause structure |
| [Governed work intervals](GOVERNED-WORK-INTERVALS.md) | Handling developer edits during governed work |
| [Classic Delivery review and rework](CLASSIC-DELIVERY-REVIEW-AND-REWORK.md) | Using Code test receipts, optional feedback attachments, and explicit reject-to-Code rework without claiming REV execution |
| [Spec → Code → Playwright testing review](SPEC-CODE-TEST-LOOP.md) | Running a specification-first, reviewer-directed Code/Test cycle with versioned intent amendments and browser evidence |
| [Bounded Story workflow rework loops](WORKFLOW-REWORK-LOOPS.md) | Authoring reviewer-directed backward phase edges, attempt budgets, and safe replay of downstream evidence |
| [Governed execution](GOVERNED-EXECUTION.md) | Action plans, execution receipts, and recoverable mutations |
| [Ad hoc work and governed landing](../README-AD-HOC-WORK.md) | Landing work that began outside a Story |
| [Release artifact handoff](RELEASE-ARTIFACT-HANDOFF.md) | Handoff and delivery artifact practices |
| [Narration contract](NARRATION-CONTRACT.md) | User-visible status and refusal messaging |
| [Operation model-policy catalog](OPERATION-MODEL-POLICY.md) | Which operations may use a model |
| [Model independence](MODEL-INDEPENDENCE.md) | Human-authored and no-model flows |

## Operations, Recovery, And Diagnostics

Use these when the system refuses, times out, or needs repair.

| Document | Use it for |
|---|---|
| [Git branches and stored state](GIT-BRANCH-STORAGE.md) | What each branch stores and what is safe to delete |
| [State authority](STATE-AUTHORITY.md) | Which state plane owns each fact |
| [Developer Experience Layer](DEVELOPER-EXPERIENCE-LAYER.md) | First-run rehearsal and bounded diagnostics |
| [DX performance](DX-PERFORMANCE.md) | Performance diagnostics and timing receipts |
| [Windows Git Bash installation compatibility](WINDOWS-GIT-BASH-INSTALL-FIX.md) | Windows shell install behavior |
| [Harness imports](HARNESS-IMPORTS.md) | Bounded reference preview and runtime conformance |
| [Ledger deployment validation](LEDGER-DEPLOYMENT.md) | Ledger trust-tier validation |
| [Verification](../VERIFICATION.md) | Test and governance checks |
| [Distribution](../DISTRIBUTION.md) | npm and VSIX distribution |

## VS Code, Copilot, MCP, And UI

Use these for user surfaces, Copilot skills, and external tool wiring.

| Document | Use it for |
|---|---|
| [VS Code guide](VS-CODE.md) | Extension panels, lifecycle, inbox, and configuration |
| [`@sflow` Chat Participant](CPT-CHAT-PARTICIPANT.md) | Implemented zero-model commands, safety mappings, and explicitly deferred drafting prerequisites |
| [Configuration Center](CONFIGURATION-CENTER.md) | Visual configuration workflows |
| [Singularity Flow Skill Catalog](SINGULARITY-FLOW-SKILLS.html) | Offline catalog of packaged Copilot skills |
| [Native Copilot](../NATIVE-COPILOT.md) | Native Copilot handoff |
| [MCP integration](MCP-INTEGRATION.md) | Governing MCP tools such as Playwright and Figma |
| [Playwright POC runbook](PLAYWRIGHT-POC-RUNBOOK.md) | Preparing and rehearsing Playwright POC evidence |
| [Mobile model intake](MOBILE-MODEL-INTAKE.md) | Figma metadata and downstream design context |
| [UI remediation plan](UI-REMEDIATION-PLAN.md) | Deferred UI alignment and improvement work |

## World Model, AST, And Token Economy

Use these for repository model creation, reuse, projections, AST behavior, and
token reduction.

| Document | Use it for |
|---|---|
| [Governed World-Model Builder v4](WORLD-MODEL-BUILDER-V4.md) | Registered repository views and governed builder contracts |
| [Persisted World-Model views](PERSISTED-WORLD-MODEL-VIEWS.md) | Exact-history persisted views and remaining activation work |
| [Future-proof world-model read contracts](FUTURE-PROOF-WORLD-MODEL.md) | Versioned model-free structural read contracts |
| [CALM World Model projection](CALM-WORLD-MODEL-PROJECTION.md) | Model-free CALM architecture projection |
| [AST Intelligence](AST-INTELLIGENCE.md) | Optional AST packs, assurance, fallback, and project binding |
| [Token Reduction preview](TOKEN-REDUCTION.md) | Code-local token reduction and cache boundaries |
| [Self-provisioning usage telemetry](SELF-PROVISIONING-USAGE-TELEMETRY.md) | Local usage and cost capture |
| [Flow Impact Framework](FLOW-IMPACT-FRAMEWORK.md) | Delivery outcome and impact measurement |

## SGOS, WEL, GDP, And CAB Programs

Use these for the larger governed-runtime and delivery-proof programs.

| Document | Use it for |
|---|---|
| [SGOS](SGOS.md) | Additive intent compiler and bounded governed runtime |
| [How to use SGOS](SGOS-USAGE-GUIDE.md) | Practical SGOS usage |
| [SGOS simulation](SGOS-SIMULATION.md) | Runtime simulation and scenarios |
| [SGOS agentic evaluation](SGOS-AGENTIC-EVALUATION.md) | Agentic evaluation behavior |
| [SGOS read model benchmark](SGOS-READ-MODEL-BENCHMARK.md) | Read model timing and measurement |
| [SGOS end-to-end release proof](SGOS-END-TO-END-RELEASE-PROOF.md) | Physical release proof package |
| [SGOS pending work](SGOS-PENDING-WORK.md) | SGOS remaining work |
| [Witnessed Engineering Loop](WEL-SPEC.md) | Witnessed clauses, bounded knowledge, and testcase evidence |
| [WEL threat model](WEL-THREAT-MODEL.md) | WEL trust, privacy, and two-plane storage |
| [WEL real-repository corpus measurement](WEL-REAL-CORPUS-MEASUREMENT.md) | Corpus measurement for JUnit/Surefire and Jest/Vitest |
| [WEL pending work](WEL-PENDING-WORK.md) | WEL remaining work |
| [Governed Delivery and Proof roadmap](GDP-DELIVERY-ROADMAP.md) | GDP milestones and release proof strategy |
| [GDP contract vNext](GDP-CONTRACT-VNEXT.md) | Non-runtime GDP contract baseline |
| [GDP local signed runner](GDP-LOCAL-SIGNED-RUNNER.md) | Local signed verification runner |
| [GDP M1-M11 documents](#gdp-milestone-files) | Detailed GDP milestone notes |
| [CAB v0.2](CAB-V0.2.md) | Code Assurance Bridge staged design |
| [CAB threat model](CAB-THREAT-MODEL.md) | CAB trust and risk model |
| [CAB roadmap](CAB-ROADMAP.md) | CAB rollout plan |
| [CAB-R2 provider foundation](CAB-R2-PROVIDER-FOUNDATION.md) | Closed provider descriptor and fail-closed readiness diagnostics |

## Architecture And Governance

Use these to explain the product to technical reviewers.

| Document | Use it for |
|---|---|
| [Architecture](../ARCHITECTURE.md) | System architecture and trust boundaries |
| [Architecture Review Board document](ARB-document-plain.html) | ARB overview and implementation-status boundaries |
| [Under the hood](UNDER-THE-HOOD.md) | Runtime internals and prompt composition |
| [Glossary](GLOSSARY.md) | Canonical terms |
| [Vocabularies](VOCABULARIES.md) | Controlled vocabulary and drift prevention |
| [Capability ledger](../CAPABILITY-LEDGER.md) | Capability hierarchy and optional proof ledger |
| [Initiative orchestration](../INITIATIVE-ORCHESTRATION.md) | Initiative/Epic orchestration across repositories |
| [Local signed deliverables](LOCAL-SIGNED-DELIVERABLES.md) | Signed deliverables without a product repository |
| [Local signed runner](GDP-LOCAL-SIGNED-RUNNER.md) | Local verifier operation and proof capture |

## Roadmaps And Planning Documents

These are planning records. They should not be treated as current user guides
unless the document itself says the feature is implemented.

| Document | Program |
|---|---|
| [Pending-work roadmap](PENDING-WORK-ROADMAP.md) | Cross-product pending work |
| [AUT v2 implementation roadmap](AUT-V2-IMPLEMENTATION-ROADMAP.md) | Developer Auto Mode |
| [CMP roadmap](CMP-ROADMAP.md) | Governed comprehension |
| [CMP brownfield](CMP-BROWNFIELD.md) | Brownfield comprehension rollout |
| [CMP real corpus measurement](CMP-REAL-CORPUS-MEASUREMENT.md) | CMP measurement |
| [FOS implementation plan](FOS-IMPLEMENTATION-PLAN.md) | Fast onboarding |
| [GDP delivery roadmap](GDP-DELIVERY-ROADMAP.md) | Governed delivery and proof |
| [WEL pending work](WEL-PENDING-WORK.md) | Witnessed Engineering Loop |
| [SGOS pending work](SGOS-PENDING-WORK.md) | SGOS |
| [UI remediation plan](UI-REMEDIATION-PLAN.md) | VS Code UI cleanup |

## GDP Milestone Files

These are detailed GDP milestone records.

| Document | Milestone |
|---|---|
| [GDP M1 compatibility inventory](GDP-M1-COMPATIBILITY-INVENTORY.md) | M1 |
| [GDP M2 shadow passport](GDP-M2-SHADOW-PASSPORT.md) | M2 |
| [GDP M3 deterministic proof](GDP-M3-DETERMINISTIC-PROOF.md) | M3 |
| [GDP M4 intent testability impact](GDP-M4-INTENT-TESTABILITY-IMPACT.md) | M4 |
| [GDP M5 outcome mode](GDP-M5-OUTCOME-MODE.md) | M5 |
| [GDP M6 workflow passport](GDP-M6-WORKFLOW-PASSPORT.md) | M6 |
| [GDP M7 SGOS execution bridge](GDP-M7-SGOS-EXECUTION-BRIDGE.md) | M7 |
| [GDP M8 promotion and UX](GDP-M8-PROMOTION-AND-UX.md) | M8 |
| [GDP M9 local hermetic observe](GDP-M9-LOCAL-HERMETIC-OBSERVE.md) | M9 |
| [GDP M10 provenance contracts](GDP-M10-PROVENANCE-CONTRACTS.md) | M10 |
| [GDP M11 readiness](GDP-M11-READINESS.md) | M11 |

## Topic Help

Files under [docs/topics](topics/) are short help-center topics used by CLI,
VS Code, and Copilot help surfaces. They are intentionally smaller and more
question-oriented than the top-level design documents.

Use topic files for:

- error explanations;
- quick command guidance;
- workflow concepts;
- UI help links;
- deterministic `@sflow` and help-center answers.

Do not use topic files as the main place for long architecture proposals.

## Architecture Decision Records

Files under [docs/adr](adr/) are durable decisions. They should be short,
stable, and rarely edited except to supersede or clarify a decision.

Current ADR groups:

- ledger and state authority: ADR 0001-0003;
- product surface retirement: ADR 0004;
- GDP authority, compatibility, proof, command, and recovery: ADR 0005-0007;
- WEL authority and local test identity: ADR 0008-0009 and ADR 0015;
- CAB authority, trust, checker boundary, risk, and rollout: ADR 0010-0013;
- CMP observe authority: ADR 0014.

## Generated Or Shareable Artifacts

These files are generated, export-oriented, or shareable. Keep them, but do not
make them the canonical source when an editable Markdown or Word source exists.

| Document | Role |
|---|---|
| [Singularity Flow Skill Catalog](SINGULARITY-FLOW-SKILLS.html) | Generated skill catalog |
| [Architecture Review Board document](ARB-document-plain.html) | Shareable ARB HTML |
| [Ways of Working PDF](SingularityFlow-Ways-of-Working.pdf) | Shareable PDF |

## Naming Convention Going Forward

Use this convention for new docs:

| Prefix or folder | Meaning |
|---|---|
| `docs/topics/` | Help-center topic |
| `docs/adr/` | Architecture decision record |
| `*-ROADMAP.md` or `*-PLAN.md` | Planning document, not necessarily implemented |
| `*-RUNBOOK.md` or `*-GUIDE.md` | Operational guide |
| `SPEC-*.md` | Imported or reviewed specification |
| `GDP-M*.md` | Governed Delivery and Proof milestone |

Before adding a new top-level doc, check whether it belongs in `docs/topics/`,
`docs/adr/`, or an existing roadmap.
