# Laptop-local Story document handoff

New workflow templates keep uploaded files, folders and images on the current laptop. Git carries
the document identity, name, hash, size and phase scope, not the original file bytes. Existing
Git-backed documents and explicitly approved older storage policies remain supported; this change
does not rewrite approved configuration or erase previously published inputs.

The private store is `<git-common-dir>/singularity-flow-documents/<Work-ID>/<sha256>/<filename>`.
All linked Story worktrees of that clone share it. Another clone, including one on another laptop,
does not receive those bytes. Store cleanup must continue to preserve these user-owned originals.

## Another laptop

Phase entry, Copilot planning, next steps, preparation, source review and prepublication check
only active local documents offered to that phase. If any are missing or changed, they return their
existing IDs, names, expected hashes and exact restore routes. The person chooses the same original
file:

```sh
singularity-flow documents restore DOC-001 --work-id WORK-ID --file "/chosen/original.png" --json
singularity-flow documents readiness --phase PHASE --work-id WORK-ID --json
```

The VS Code evidence row opens a file picker for a missing local original. Restore verifies its
hash and size, refuses a different file, preserves any damaged local copy, and changes no Git ref,
document ID, approval or Story phase. Settled clarification answers stay bound to the same durable
prompt. A genuinely changed source still needs a normal governed source update, not a restore.

## Copilot delivery and source review

Local text and supported Office renditions are supplied in bounded, untrusted runtime context.
The complete delivered context gets a private file and exact CLI-issued read path. Durable prompt
snapshots contain metadata only. A manually requested `wm compose --out` writes the durable prompt,
not this private overlay. Reading evidence with Copilot still uses its normal model/tool channel;
local Git storage does not mean that a model can inspect a file without receiving its content.

Copilot planning receives the same private overlay. The planning pack's `context.md`, which
promotion copies into Git, keeps each local document's ID, name and hash only; the result's
`localContext` names the private file under the Git directory that carries the verified text.
Planning a phase whose local original is missing is refused with the same restore route.

Images and PDFs get verified native-inspection paths. Source review requires a receipt containing
the actual tool method, page/region and observations, plus source mappings. It does not invent text
line numbers for pixels or claim built-in OCR. When a host lacks an appropriate tool, the agent asks
for help or a verifiable export rather than claiming inspection. Normal textual citations remain
exact, and human approval/exclusion authority is unchanged. Generated authored artifacts and
review reports can contain evidence-derived summaries or quotations; they are not original uploads.

Older retained reviews keep their previously verified source-readability contract for that same
generation. New generations use the new readers. Current bytes are still hash-verified before an
older contract is reused.

## Qualification

Regression suites cover CLI takeover, unchanged IDs and review bindings, phase scope, local-only
source delivery, corrupted-copy preservation, wrong-file and symlink refusal, visual receipts,
older retained reviews, upload/review tool permissions, Office extraction and VS Code intake.
The second-laptop case is simulated with an independent clone and private store. It is not a claim
of native Windows or live Copilot host qualification.

The initial UI bundle check exposed about 151 KB of unnecessary native hook closure. Build-time
host boundaries now keep that CLI-only graph out of the extension. The gateway allowance adds one
document-runtime module and 17 KB for the feature; the extension entry and all other module/byte
limits remain unchanged. No new dependency or OCR/PDF runtime is introduced.
