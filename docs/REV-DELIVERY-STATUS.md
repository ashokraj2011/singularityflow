# REV delivery status and activation boundary

Singularity Flow includes a guarded, interactive Revision Loop pilot for exact code-Candidate refinement. The pilot joins Candidate retention, route, packet, append-only head journal, manual capture, and deterministic precheck behind preview/confirmation contracts. It does not expose a public Candidate-comparison UI. Restoration and ordinary Story publication integration are not exposed by this guarded profile.

It is deliberately **not** an autonomous model executor and does not imply release eligibility. Check the installed boundary with `singularity-flow revision capabilities --json`; run `singularity-flow revision activation --json` from the exact repository to see current eligibility and blockers. Those commands are read-only and are the operational source of truth for the installed build.

## Guarded pilot available now

- `singularity-flow revision status|card|show ... --json` reads bounded loop, Candidate, interval, precheck, and recovery state.
- `singularity-flow revise --dry-run --feedback-stdin --saved-buffers-confirmed [--criteria ID] [--attachment-set SHA] --json` creates an exact preview. It binds feedback bytes, the exact clean source snapshot (or an already-retained loop head), approved criterion identities, active attachment set, repository/Story/phase generation, route, policy, proof profile, execution unit, and budgets. It does not retain a first parent, open an interval, or change application code.
- `singularity-flow revise --feedback-stdin --saved-buffers-confirmed [same selectors] --confirm sha256:<PLAN> --json` revalidates the exact preview before opening one bounded interval. Changed authority, Candidate, phase, buffers, attachments, feedback, or plan fails closed.
- For the first interval, successful confirmation retains the previewed source snapshot as the immutable parent Candidate. Later previews bind the loop's already-retained selected head.
- A routing-required preview cannot be confirmed. Its structured `routing` field is the exact result. `/sf-recommend` and `singularity-flow recommend --json` only re-evaluate the repository's current next step; they do not consume the preview's routing plan.
- `/sf-revise` provides the same preview/explicit-confirmation flow in Copilot. It stops before ordinary phase publication, submission, approval, merge, or deployment. `@sflow /revise` performs read-only status/card inspection or prefills `/sf-revise`; the participant never starts a revision directly.
- A confirmed interval can admit only a result Candidate produced through the returned safe built-in packet/capture/precheck actions. It cannot run arbitrary shell commands, Git commands, an autonomous model agent, unknown network effects, or organization-specific test infrastructure.
- `revision resume` is a bounded local recovery mutation: it may finish precheck from an already retained Candidate or repair a journal/pointer gap when exact immutable evidence exists. It never repeats an uncertain attempt. Capturing or recovery-required state cannot be abandoned; the separately previewed/confirmed abandon flow applies only when no capture is in flight.
- The guarded pilot stops at a retained, prechecked local Candidate. This build does **not** bridge that selected REV head into ordinary phase publication; ordinary publication does not consume a REV selection automatically. Full selected-Candidate publication remains disabled until registered quality/proof adapters and the publication bridge are release-qualified.

## Feedback attachments

- `revision attachments capabilities|preview|register|list|status|remove-preview|remove` binds private feedback evidence to an exact Story, phase generation, HEAD, source tree, configuration, workflow, feedback digest, and repository identity. Registration and exclusion require separate exact confirmations. Exclusion is append-only; it does not erase historical proof.
- Shell selection supports up to five explicit files, one-based file selection, and bounded line ranges. Default local-file formats are `.txt`, `.md`, `.json`, `.csv`, and `.tsv`; CSV/TSV preserve selected-row provenance.
- VS Code `@sflow /attachments` previews genuine local file URIs and offers a one-use registration confirmation. It cannot recover opaque Copilot-upload bytes. Binary PDF/DOCX/image intake remains disabled without an installed, approved scanner/extractor.
- Attachment registration never starts a revision. A later `/sf-revise` preview must name and revalidate the exact active attachment-set digest.

## Evidence and safety boundary

The machine-local append-only journal uses compare-and-swap for the selected head. Candidate references, route/packet plans, context, and precheck are content-addressed and rechecked at mutation time. Each successful start confirmation has an immutable result receipt keyed by its exact plan digest, so the same feedback and selectors replay the original result even after a later interval replaces the current pointer. Other historical mutations are not replayable. Changed bytes or authority require a new preview. This profile neither claims automatic restoration nor creates an ordinary phase-publication selection.

The built-in attempt bridge is intentionally narrow. It can apply only explicitly admitted bounded operations and return exact non-promoting bytes after cleanup. It is not authority to:

- invoke an autonomous Copilot/model coding agent;
- launch arbitrary shell, Git, project-build, or project-test commands;
- claim network or other external effects are absent without a witness;
- convert `observed-unverified` Code-check output into a signed test receipt;
- amend approved specification text or requirement identities;
- publish, submit, approve, merge, or deploy.

Code-phase tests, screenshots, or Playwright observations may be attached to the Candidate card only with their real provenance. They remain evidence for review and do not replace the workflow's later Testing/Verification verdict.

## Remaining work beyond the safe built-in pilot

- Replace the current single-journal 512-entry safety ceiling with durable journal-segment rollover
  and segment-chain verification. The `revision-loop.segments` values currently summarize groups of
  interval digests; they do not yet remove that local storage ceiling. This is a guarded-pilot
  limitation, not a claim that revision count is governance authority.
- Approved isolated model/code executor with process-tree quiescence and external-effect resolution.
- Trusted editor-buffer adapter where the host cannot prove saved/captured buffers.
- Organization-approved quality-command adapters and authenticated durable test receipts.
- Exact selected-head integration with ordinary Story phase publication.
- Binary attachment scanning/extraction and timed quarantine expiry.
- Full macOS/Linux/Windows fault witness matrix and a release-owned profile attestation.
- Decision owner and independent validator for default/full-profile activation.

Classic Delivery's reviewer reject-to-Code cycle and workflow rework loops remain available and are different from REV. A workflow loop changes the active phase route; a REV interval refines an exact Candidate inside one open code generation.

## Release gate

Do not label the guarded built-in profile “REV complete,” “autonomous,” or “release certified.” Do not enable unrestricted execution from a repository flag. Full/default activation requires the applicable witness matrix, current release manifest, platform coverage, approved executor and receipt boundaries, and the specification's independent decision owner and validator.
