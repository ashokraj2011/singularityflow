import { SingularityFlowError } from './util.mjs';

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const AGENT_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PROFILE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;

function invalid(message, code) {
  throw new SingularityFlowError(message, { code });
}

function exactKeys(value, allowed, label, code) {
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (extras.length) invalid(`${label} contains unknown field '${extras[0]}'.`, code);
}

function digestList(value, label, noun, code) {
  if (!Array.isArray(value)) invalid(`${label} must be an array.`, code);
  const seen = new Set();
  const entries = value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      invalid(`${label}[${index}] must be an object.`, code);
    }
    exactKeys(entry, new Set(['logicalId', 'sha256']), `${label}[${index}]`, code);
    const logicalId = String(entry.logicalId ?? '');
    if (!logicalId || /[\r\n\0]/.test(logicalId) || Buffer.byteLength(logicalId, 'utf8') > 512) {
      invalid(`${label}[${index}].logicalId is invalid.`, code);
    }
    if (seen.has(logicalId)) invalid(`${label} repeats ${noun} '${logicalId}'.`, code);
    seen.add(logicalId);
    if (!SHA256.test(String(entry.sha256 ?? ''))) {
      invalid(`${label}[${index}].sha256 must be a canonical sha256:<digest> identity.`, code);
    }
    return Object.freeze({ logicalId, sha256: entry.sha256 });
  });
  return Object.freeze(entries.sort((left, right) => (
    left.logicalId < right.logicalId ? -1 : left.logicalId > right.logicalId ? 1 : 0
  )));
}

/**
 * Normalize the content-free execution provenance stored beside a prompt.
 *
 * Omission is intentionally caller-controlled. Repository-level prompts can truthfully be
 * `legacy-live`; a prompt already associated with a Story cannot make that claim merely because a
 * caller forgot the new field, and therefore uses `historical-unproven` unless the caller proves a
 * current saved closure explicitly.
 */
export function normalizePromptExecutionContext(value, {
  omittedMode = 'historical-unproven',
  code = 'PROMPT_EXECUTION_CONTEXT_INVALID',
  label = 'Prompt execution context'
} = {}) {
  const candidate = value == null ? { mode: omittedMode } : value;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    invalid(`${label} must be an object.`, code);
  }
  if (candidate.mode === 'legacy-live' || candidate.mode === 'historical-unproven') {
    exactKeys(candidate, new Set(['mode']), label, code);
    return Object.freeze({ mode: candidate.mode });
  }
  if (candidate.mode !== 'workflow-snapshot') {
    invalid(`${label} mode must be workflow-snapshot, legacy-live, or historical-unproven.`, code);
  }
  exactKeys(candidate, new Set([
    'mode', 'snapshotHash', 'agentId', 'agentBlobSha256', 'dependencies', 'instructions',
    'parserProfile', 'composerProfile', 'overrideSha256'
  ]), label, code);
  for (const field of ['snapshotHash', 'agentBlobSha256']) {
    if (!SHA256.test(String(candidate[field] ?? ''))) {
      invalid(`${label}.${field} must be a canonical sha256:<digest> identity.`, code);
    }
  }
  if (!AGENT_ID.test(String(candidate.agentId ?? ''))) {
    invalid(`${label}.agentId must be a lower-case kebab-case agent ID.`, code);
  }
  for (const field of ['parserProfile', 'composerProfile']) {
    if (!PROFILE.test(String(candidate[field] ?? ''))) {
      invalid(`${label}.${field} must be a supported lower-case profile ID.`, code);
    }
  }
  if (candidate.overrideSha256 != null && !SHA256.test(String(candidate.overrideSha256))) {
    invalid(`${label}.overrideSha256 must be null or a canonical sha256:<digest> identity.`, code);
  }
  const dependencies = digestList(candidate.dependencies, `${label}.dependencies`, 'dependency', code);
  // Reusable instructions referenced by retained skills joined the identity after the first
  // snapshot contexts were stored. Keep the list exactly when present, so newer handoffs are
  // accepted and older stored contexts normalize to the same bytes they always had.
  const instructions = candidate.instructions === undefined ? null
    : digestList(candidate.instructions, `${label}.instructions`, 'instruction', code);
  return Object.freeze({
    mode: 'workflow-snapshot',
    snapshotHash: candidate.snapshotHash,
    agentId: candidate.agentId,
    agentBlobSha256: candidate.agentBlobSha256,
    dependencies,
    ...(instructions ? { instructions } : {}),
    parserProfile: candidate.parserProfile,
    composerProfile: candidate.composerProfile,
    overrideSha256: candidate.overrideSha256 ?? null
  });
}

export function modelRequestIsStoryScoped(subject) {
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) return false;
  if (subject.workId != null) return true;
  return ['story', 'specification-quality', 'convergence'].includes(subject.kind);
}
