/** Read-only, bounded annotation repair instructions for the existing producer loop. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { canonicalJson } from './records.mjs';
import { EXPLANATION_LIMITS } from './implementation-bindings.mjs';
import { secureRepositoryPath } from './util.mjs';

const MAX_PATHS = 256;
const MAX_BYTES = 2 * 1024 * 1024;

const digest = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

async function repairTarget(root, relative, candidates) {
  // A planned path is not automatically a permitted current-generation edit. The delivery
  // preflight supplies candidates only after its protected-path, source-boundary and scope checks.
  if (!candidates.has(relative)) return { path: relative, status: 'not-in-candidate', sha256: null };
  let handle;
  try {
    const secured = await secureRepositoryPath(root, relative, { label: 'Traceability repair target' });
    if (!secured.exists) return { path: relative, status: 'missing', sha256: null };
    if (!secured.entry?.isFile() || secured.entry.nlink !== 1) {
      return { path: relative, status: 'unsafe', sha256: null };
    }
    handle = await open(secured.absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES
        || before.dev !== secured.entry.dev || before.ino !== secured.entry.ino) {
      return { path: relative, status: 'unavailable', sha256: null };
    }
    // Read at most the limit plus one, even if the file grows after stat.
    const bytes = Buffer.alloc(Math.min(before.size + 1, MAX_BYTES + 1));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      return { path: relative, status: 'changed-during-read', sha256: null };
    }
    const content = bytes.subarray(0, bytesRead);
    new TextDecoder('utf-8', { fatal: true }).decode(content);
    if (content.includes(0)) return { path: relative, status: 'unsupported-content', sha256: null };
    return { path: relative, status: 'available', sha256: createHash('sha256').update(content).digest('hex') };
  } catch {
    return { path: relative, status: 'unavailable', sha256: null };
  } finally {
    await handle?.close();
  }
}

/**
 * A plan path is a place to inspect, not a semantic test/function mapping. The producer must
 * verify existing behavior before annotating; unresolved meaning needs clarification, and absent
 * behavior needs implementation. This projection never writes tags, accepts risk or runs tests.
 */
export async function traceabilityRepairProjection(root, input, { workId, phase, sameTurn }) {
  if (!input?.actions?.length) return null;
  const names = [...new Set(input.actions.flatMap((action) => action.expectedPaths))].sort();
  if (input.actions.length > MAX_PATHS || names.length > MAX_PATHS) {
    return Object.freeze({ status: 'manual-review', sameTurn: false, actions: [],
      fingerprint: digest({ workId, phase: phase.id, status: 'limit-exceeded' }),
      guidance: 'Traceability repair exceeds the bounded target limit; review the allocation before retrying.' });
  }
  const candidates = new Set([...input.sourcePaths, ...input.testPaths]);
  const targets = new Map();
  for (const name of names) targets.set(name, await repairTarget(root, name, candidates));
  const actions = input.actions.map((action) => {
    const paths = [...new Set(action.expectedPaths)].sort().map((name) => targets.get(name));
    const eligible = action.approved && paths.some((target) => target.status === 'available');
    const disposition = !action.approved || !paths.length ? 'clarify-mapping'
      : eligible ? 'verify-existing-behavior' : 'repair-implementation-or-test';
    return Object.freeze({
      kind: action.kind, clauseId: action.clauseId, line: action.line ?? null,
      tag: `${action.kind.startsWith('acceptance-') ? '@ac' : '@clause'}:${action.clauseId}`,
      placement: action.kind.startsWith('acceptance-') ? 'directly-before-executable-test'
        : action.kind === 'clause-explanation' ? 'existing-tag-line' : 'source-hunk',
      ...(action.kind.startsWith('acceptance-') ? {} : { explanationLimits: EXPLANATION_LIMITS }),
      ...(action.regions?.length ? { regions: action.regions.filter((region) =>
        paths.some((target) => target.path === region.path && target.status === 'available')) } : {}),
      paths, disposition, requiresSemanticVerification: true,
      sameTurn: sameTurn && eligible,
      fingerprint: digest({ workId, phase: phase.id, intent: phase.generationIntent?.id ?? null,
        plan: input.plan, kind: action.kind, clauseId: action.clauseId, line: action.line ?? null, paths })
    });
  });
  return Object.freeze({
    status: sameTurn ? 'producer-repair' : 'owner-review', sameTurn,
    plan: input.plan, actions: Object.freeze(actions),
    fingerprint: digest(actions.map((action) => action.fingerprint)),
    guidance: 'Use the existing producer repair loop. Read each approved clause and its exact planned paths; annotate only behavior already verified there. Place @ac directly above the executable test, and explain how the change meets @clause in 10 to 300 characters. If behavior or tests are missing, implement them; if the mapping remains ambiguous, ask for clarification. Recheck, then run the configured affected tests before publication. Tags alone prove neither correctness nor a test run.'
  });
}

/** Add scoped source/test repair progress without letting unrelated files hide an unchanged finding. */
export function traceabilityDraftFingerprint(artifactFingerprint, repair) {
  return repair ? digest({ artifactFingerprint, traceability: repair.fingerprint }) : artifactFingerprint;
}
