---
name: sflow-approve
description: Review and approve a submitted phase as the current Git identity, recording its human authority group, phase-default agent, self-approval warning, hashes, commit, and push.
disable-model-invocation: true
argument-hint: "[WORK-ID] [--fetch]"

---
# Approve the submitted phase

<!-- sflow-output-contract: governed-review -->
**Output contract:** Show governed artifacts, hashes, identity warnings, and the exact confirmation before recording any decision.

Never edit state to bypass a gate. The current Git identity—not the governed agent—must match a configured approval authority.

1. **Always resolve the exact review first.** Run `singularity-flow choices begin approve <WORK-ID> --fetch --json`. This checks out/fetches the requested Story and returns the authoritative phase, generation, artifact hashes, review-packet hash, and one-time token. Do not begin with an ambient `phase show`; it may read another Story.
2. Run `singularity-flow phase show <phase> --json` using `approvalContext.phase`. Require its Work ID, phase, generation, paths, and SHA-256 values to match `approvalContext`. Any missing document, preview error, hash mismatch, generation mismatch, or empty submitted artifact set stops approval and is reported as a review-integrity failure.
3. **Always show the generated artifacts in Copilot before asking for a decision.** In a visible assistant response, reproduce every returned generated current-phase text document in full between `--- BEGIN <path> ---` and `--- END <path> ---`, with ID, kind, bytes, generation, and full SHA-256. A Shell/tool block does not satisfy artifact review. Show binary/image paths and metadata. If response bounds require several messages, continue until every document is visible; never truncate or summarize instead. Never say “shown above.” Never ask for approval based only on a filename or summary.
4. After the complete artifact display, show reviewer identity/authority, phase agent, checks, usage, prior decisions, generator identity, review-packet hash, and self-approval warning. Unauthorized identity stops; changing agents cannot grant authority.
5. Only now: Ask the reviewer to type the exact phase ID from `approvalContext.phase`. Do not supply, autocomplete, infer, or silently record it. Run `singularity-flow choices answer <TOKEN> phase-confirmation <TYPED-PHASE> --json`, then `singularity-flow approve <TYPED-PHASE> --work-id <WORK-ID> --fetch --selection-receipt <TOKEN>` only when `ready: true`. Never add `--yes`; the CLI revalidates and consumes the receipt exactly once.
6. If selection begins with `Out of sequence` or `Soft sequence warning`, load and visibly render any current generated artifacts from the now-selected Story before relaying the refusal; leave `continue` to the human and record no decision.
7. Report commit/push, reviewer, authority, agent, assurance, self-approval, remaining threshold, and next phase. Do not merge, deploy, or alter Jira.
8. Reproduce `Context boundary` and `Next Copilot actions` exactly. For `new`, request `/clear` then `/sf-next`; for `compact`, request `/compact` then `/sf-next`; stop before the next phase.
