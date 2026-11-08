# Shared required-artifact inspection

The kernel now owns the complete required-text observation rule and the existing native
UTF-8/binary classifier. Native prepublication, manual imports and review metadata writers
use those same owners. The SDK's pure `artifacts` entry also exposes the observation helpers
for explicit Node hosts. The namespace working-draft preview keeps its existing single-pass
decoder and its byte-preserving text/binary response.

## Responsibility boundary

An adapter reads actual bytes and computes the normalized content digest. The pure rule owner
parses authored Markdown, excludes existing managed metadata and upstream input blocks, applies
the pinned phase contract and returns findings. It performs no filesystem, Git, process, model,
identity or storage operation.

```js
import { createHash } from 'node:crypto';
import {
  artifactBytesAreText, artifactContentObservation,
  inspectRequiredArtifactObservation, inspectBinaryArtifactSize
} from '@singularity-flow/engine-sdk/artifacts';

let findings;
if (artifactBytesAreText(actualBytes)) {
  const observation = artifactContentObservation(Buffer.from(actualBytes).toString('utf8'));
  const fingerprint = `sha256:${createHash('sha256').update(observation.fingerprintText).digest('hex')}`;
  findings = inspectRequiredArtifactObservation(observation, pinnedPhase, {
    path: logicalArtifactKey, generation, fingerprint
  });
} else {
  findings = inspectBinaryArtifactSize(actualBytes.byteLength, pinnedPhase, {
    path: logicalArtifactKey
  });
}
```

The text rule preserves authored-byte bounds, template-baseline comparison, placeholder and
required-heading findings, managed-metadata integrity, line numbers, priorities and option
semantics. Hashing remains an explicit adapter responsibility. The observation carries its
normalized fingerprint text; the host hashes that exact text with SHA-256. A digest is a binding
observation, not authenticated permission or a human decision.

Binary artifacts retain their exact byte bounds. A binary body cannot satisfy a required
text-heading or placeholder contract. The shared classifier's actual native behavior is retained:
UTF-8 without NUL is text, including empty bytes and a UTF-8 BOM; invalid/truncated UTF-8 and
NUL-bearing content are binary. Metadata-writing callers keep using this classification, with
the existing function identity, so the extraction introduces no new decoding or byte rewriting.

The registered draft-health, prepublication and publication operations separately enforce their
full phase contracts. These content findings do not establish source scope, test execution,
clarification, external evidence, lifecycle admission, producer authority or approval. A host
must still use the corresponding registered operation and actual policy/execution ports.

## Native compatibility

`inspectRequiredArtifactText` retains its native signature. It observes the actual text, hashes
the observation through the existing native hash function and delegates the complete finding
composition to the kernel. Native binary validation delegates to the existing kernel byte-size
rule. Neither adapter reimplements baseline, metadata or binary contract decisions.

The 37 previously captured complete native content/metadata/repair results remain frozen in
`test/fixtures/engine-artifact-content/native-v1.json`. The ten byte-classifier samples and its
original syntax-body hash were captured from `b3e757269` before moving the function. Existing
parser, identity, rule and repair bodies remain covered by the original capture.

The new SDK working-draft reader now identifies its response as
`sflow-phase-working-draft-manifest/v1`. Its earlier unreleased preview accidentally reused
`sflow-phase-draft-manifest/v1`, which already identifies the registered draft-health report.
The existing draft-health identifier and meaning are preserved. The working response's fields
and all persisted private/shared records are unchanged; no data migration or authority cutover
is introduced by the corrected response tag.

## Remaining integration

This is a Phase 5 publication-rule extraction and a Phase 7 portable-host prerequisite. Actual
namespace publication still needs its full lifecycle/dependency observations, retained candidate,
source/test bindings, conditional canonical commit and recovery coordination. Submission,
decisions, approval, complete cross-agent runtime, verified migration and final distribution
qualification remain in the migration plan. A successful content inspection does not close those
milestones or substitute a caller-supplied ready flag for an engine rule.

## Mac qualification

On Node 26.12.0, 221 distinct checks across 11 affected test files passed, with no failures,
cancellations or skips. The 25 private-preparation cases were rechecked after retaining the
namespace preview's existing single-pass decoder; those repeats are excluded from the distinct
count. Coverage includes the frozen 37 native content results, byte-classifier syntax and samples,
Unicode sizing, actual native code publication/refusals, SDK/CLI/source/bundle draft and
prepublication parity, original-generation recovery, separate-store private drafts and the
installed SDK's pure-import and NodeNext declarations. A complete binary-artifact journey
published, submitted and approved a PDF with its actual bytes unchanged.

Source validation passed 3,804 checks. VS Code typechecking, the Git ownership audit (2,011
existing sites), whitespace validation and all 13 existing bundle budgets passed. The gateway
remains 851 modules / 6,853,185 bytes and the extension 152 modules / 1,289,292 bytes, with no
ceiling increase. The SDK archive still exposes 49 registered operations; its additional artifact
utilities are pure library exports. All fixtures used isolated local repositories and machine
state. No Windows, hosted CI, live model, installed-project migration, install, push or merge ran.
