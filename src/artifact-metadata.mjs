/** Pure managed-envelope inspection; shared by prepublication and independent review. */
import { MANAGED_INPUTS, MANAGED_METADATA, MANAGED_METADATA_MARKER } from './artifact-review-read.mjs';
function lineAt(text, index) { return text.slice(0, index).split('\n').length; }

export function inspectManagedArtifactMetadata(text) {
  const source = String(text ?? '');
  const leading = source.match(MANAGED_METADATA)?.[0] ?? null;
  const authoredRegion = (leading == null ? source : source.slice(leading.length))
    // Keep offsets stable so the reported line still refers to the original artifact.
    .replace(MANAGED_INPUTS, (block) => block.replace(/[^\n]/gu, ' '));
  const markerIndex = authoredRegion.search(MANAGED_METADATA_MARKER);
  if (leading != null && markerIndex < 0) {
    return Object.freeze({ status: 'valid', line: null, leading });
  }
  if (leading == null && markerIndex < 0) {
    return Object.freeze({ status: 'missing', line: 1, leading: null });
  }
  const absoluteIndex = leading == null
    ? markerIndex
    : leading.length + markerIndex;
  return Object.freeze({
    status: leading == null && absoluteIndex === 0 ? 'malformed' : 'duplicate-or-misplaced',
    line: lineAt(source, Math.max(0, absoluteIndex)),
    leading
  });
}
