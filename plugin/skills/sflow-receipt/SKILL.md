---
name: sflow-receipt
description: Replay compact evidence for a submitted phase.
argument-hint: "[WORK-ID]"

---
# Show a Singularity Flow evidence receipt

<!-- sflow-output-contract: concise-relay -->
**Output contract:** This is a read-only replay. Preserve unavailable and partial evidence as such, include the receipt hash, and make no lifecycle or repository change.

Run `singularity-flow receipt show --work-id <WORK-ID> --json`, using the supplied Work ID or the attached Story. Report the exact phase and generation, source commit, changed-path count, requirement coverage, checks, approvals, governed context, publication state, review-packet hash, and receipt hash. Never turn unavailable evidence into zero or success. If the user asks for a review-ready form, run the same command with `--markdown` and display the complete bounded Markdown.
